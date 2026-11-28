<?php
/**
 * Quotations ("Drukuj ofertę") for the multi-furniture configurator. BFF-only endpoints
 * (includes/bff.php): every call is signed by the configurator's server and carries the customer's
 * anonymous session; a quotation is reachable only by the session that created it.
 *
 * - POST /multi3d/v1/quotes                     reserve: {arrangement_sha256, share{token_hash, snapshot,
 *                                               schema_version}} → {id, number, created_at, expires_at}.
 *                                               Creates the quotation row (UUID v4 id, unique number) and the
 *                                               immutable configuration snapshot whose link the PDF prints,
 *                                               in one transaction.
 * - GET  /multi3d/v1/quotes                     the calling session's quotations.
 * - PUT  /multi3d/v1/quotes/<id>                {number, quote, renderings, arrangement_sha256}: the quotation
 *                                               JSON (configuration + pricing snapshot) and rendering metadata
 *                                               as post meta of the "multi3d_quote" record. Once.
 * - POST /multi3d/v1/quotes/<id>/pdf            the PDF (raw body), written once, outside the database.
 * - GET  /multi3d/v1/quotes/<id>/pdf            the stored PDF.
 * - POST /multi3d/v1/quotes/<id>/renderings/<n> rendering n (raw PNG body), written once.
 * - POST /multi3d/v1/quotes/<id>/email          {email}: sends the stored PDF with wp_mail (rate-limited).
 * - POST /multi3d/v1/quotes/<id>/cart-claim     single-use claim (1 h) linking the cart hand-off to the quotation.
 *
 * The quotation number (OF-YYYYMMDD-XXXXXX) is for people only: it is never accepted as an identifier or
 * as proof of anything. Files live in uploads/multi3d-quotes/<id>/ behind "Require all denied".
 *
 * Retention: temporary quotations (and their configuration link) expire after 60 days (daily WP-Cron);
 * a quotation whose cart was ordered is marked "ordered" and kept, and the order gets its own copy.
 *
 * Legacy quotations (stored before the BFF, CPT records named by number without a table row) have no
 * owner: no session can reach them through the API, their former public endpoints no longer exist, and
 * they are still removed by the purge after their 60 days.
 *
 * @package multi3d
 */

defined( 'ABSPATH' ) || exit;

const MULTI3D_QUOTE_POST_TYPE          = 'multi3d_quote';
const MULTI3D_QUOTE_RETENTION_DAYS     = 60;
const MULTI3D_QUOTE_MAX_PDF_BYTES      = 8388608;
const MULTI3D_QUOTE_MAX_RENDER_BYTES   = 12582912; // PHP post_max_size must allow this (1920x1080 PNG: ~2-6 MB).
const MULTI3D_QUOTE_MAX_IMAGES         = 3;
const MULTI3D_QUOTE_MAX_META_BYTES     = 16384;
const MULTI3D_QUOTE_MAX_JSON_BYTES     = 262144;
const MULTI3D_EMAILS_PER_HOUR          = 5;
const MULTI3D_EMAILS_PER_DAY_SESSION   = 10;
const MULTI3D_QUOTES_PER_HOUR_IP       = 20;
const MULTI3D_QUOTES_PER_HOUR_SESSION  = 10;
const MULTI3D_QUOTE_NUMBER_ATTEMPTS    = 8;
const MULTI3D_QUOTE_RESERVATION_HOURS  = 24;
const MULTI3D_CART_CLAIM_SECONDS       = 3600;
/** Legacy numbers (4 characters) and current ones (6 characters). */
const MULTI3D_QUOTE_NUMBER_RE          = '/^OF-\d{8}-[A-Z0-9]{4,6}$/';
const MULTI3D_QUOTE_LEGACY_NUMBER_RE   = '/^OF-\d{8}-[A-Z0-9]{4}$/';

add_action(
	'init',
	function () {
		register_post_type(
			MULTI3D_QUOTE_POST_TYPE,
			array(
				'label'           => __( 'Configurator quotations', 'multi3d' ),
				'public'          => false,
				'show_ui'         => true,
				'show_in_menu'    => 'woocommerce',
				'supports'        => array( 'title' ),
				'capability_type' => 'shop_order',
				'map_meta_cap'    => true,
			)
		);
	}
);

function multi3d_schedule_quote_purge() {
	if ( ! wp_next_scheduled( 'multi3d_purge_quotes' ) ) {
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', 'multi3d_purge_quotes' );
	}
}

function multi3d_unschedule_quote_purge() {
	wp_clear_scheduled_hook( 'multi3d_purge_quotes' );
}

function multi3d_quotes_root() {
	$uploads = wp_upload_dir();
	return trailingslashit( $uploads['basedir'] ) . 'multi3d-quotes';
}

/** File directory of a quotation: by internal id (current) or by number (legacy). */
function multi3d_quote_dir( $key ) {
	return multi3d_quotes_root() . '/' . $key;
}

function multi3d_ensure_quote_dir( $id ) {
	$dir = multi3d_quote_dir( $id );
	if ( ! wp_mkdir_p( $dir ) ) {
		return null;
	}
	// The files are only e-mailed, served to their owner through the BFF, or opened by staff.
	$root = multi3d_quotes_root();
	if ( ! file_exists( $root . '/.htaccess' ) ) {
		file_put_contents( $root . '/.htaccess', "Require all denied\nDeny from all\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		file_put_contents( $root . '/index.php', "<?php // Silence.\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions
	}
	return $dir;
}

/** "OF-20261124-7K3QZD": date plus 6 characters from a CSPRNG (30 bits; uniqueness is enforced by the database). */
function multi3d_generate_quote_number() {
	$alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	$suffix   = '';
	for ( $i = 0; $i < 6; $i++ ) {
		$suffix .= $alphabet[ random_int( 0, strlen( $alphabet ) - 1 ) ];
	}
	return 'OF-' . gmdate( 'Ymd' ) . '-' . $suffix;
}

/** The quotation row with this id owned by `$owner`, or null (unknown and foreign quotations look the same). */
function multi3d_owned_quote( $id, $owner ) {
	global $wpdb;
	if ( null === $owner || ! preg_match( MULTI3D_UUID_RE, (string) $id ) ) {
		return null;
	}
	$table = multi3d_table( 'quotes' );
	$row   = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %s", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	if ( ! $row || ! hash_equals( (string) $row['owner_hash'], $owner ) ) {
		return null;
	}
	if ( 'ordered' !== $row['status'] && ! empty( $row['expires_at'] ) && $row['expires_at'] < multi3d_now_utc() ) {
		return null;
	}
	return $row;
}

function multi3d_is_duplicate_key_error( $error ) {
	return is_string( $error ) && false !== stripos( $error, 'Duplicate' );
}

/**
 * Reserves a quotation: a row with a fresh UUID and a unique number, plus its configuration snapshot,
 * in one transaction. A number collision (unique index) is retried with a new number inside the same
 * transaction (MySQL rolls back the failed statement only). Returns the row or a WP_REST_Response.
 */
function multi3d_reserve_quote( $owner, $arrangement_sha256, array $share ) {
	global $wpdb;
	$quotes = multi3d_table( 'quotes' );
	$wpdb->query( 'START TRANSACTION' );
	$suppress = $wpdb->suppress_errors( true );
	$row      = null;
	for ( $attempt = 0; $attempt < MULTI3D_QUOTE_NUMBER_ATTEMPTS; $attempt++ ) {
		$candidate = array(
			'id'                 => multi3d_uuid4(),
			'number'             => apply_filters( 'multi3d_quote_number', multi3d_generate_quote_number(), $attempt ),
			'owner_hash'         => $owner,
			'arrangement_sha256' => $arrangement_sha256,
			'status'             => 'reserved',
			'has_pdf'            => 0,
			'created_at'         => multi3d_now_utc(),
			// A reservation that never receives its quotation document is removed after a day.
			'expires_at'         => gmdate( 'Y-m-d H:i:s', time() + MULTI3D_QUOTE_RESERVATION_HOURS * HOUR_IN_SECONDS ),
		);
		if ( false !== $wpdb->insert( $quotes, $candidate ) ) {
			$row = $candidate;
			break;
		}
		if ( ! multi3d_is_duplicate_key_error( $wpdb->last_error ) ) {
			break;
		}
		do_action( 'multi3d_quote_number_collision', $candidate['number'] );
	}
	$shared = $row ? multi3d_insert_share( $share['token_hash'], $share['snapshot'], $share['schema_version'], $owner, $row['id'] ) : null;
	if ( $row && $shared ) {
		$wpdb->update( $quotes, array( 'share_id' => $shared['id'] ), array( 'id' => $row['id'] ) );
		$row['share_id'] = $shared['id'];
		$wpdb->query( 'COMMIT' );
	} else {
		$wpdb->query( 'ROLLBACK' );
		$row = null;
	}
	$wpdb->suppress_errors( $suppress );
	return $row;
}

function multi3d_rest_reserve_quote( WP_REST_Request $request ) {
	$owner = multi3d_bff_owner( $request );
	if ( null === $owner ) {
		return multi3d_error( 'no_session', 401 );
	}
	$body  = $request->get_json_params();
	$body  = is_array( $body ) ? $body : array();
	$share = is_array( $body['share'] ?? null ) ? $body['share'] : array();
	$hash  = (string) ( $body['arrangement_sha256'] ?? '' );
	if ( ! preg_match( MULTI3D_HASH_RE, $hash ) || ! preg_match( MULTI3D_HASH_RE, (string) ( $share['token_hash'] ?? '' ) )
		|| ! multi3d_valid_snapshot( $share['snapshot'] ?? null ) || (int) ( $share['schema_version'] ?? 0 ) < 1 ) {
		return multi3d_error( 'snapshot_invalid', 422 );
	}
	if ( multi3d_rate_limit_request( $request, 'quote', MULTI3D_QUOTES_PER_HOUR_IP, MULTI3D_QUOTES_PER_HOUR_SESSION, HOUR_IN_SECONDS ) ) {
		return multi3d_error( 'rate_limited', 429 );
	}
	$row = multi3d_reserve_quote(
		$owner,
		$hash,
		array(
			'token_hash'     => $share['token_hash'],
			'snapshot'       => $share['snapshot'],
			'schema_version' => (int) $share['schema_version'],
		)
	);
	if ( ! $row ) {
		return multi3d_error( 'storage_failed', 500 );
	}
	return multi3d_json(
		array(
			'id'         => $row['id'],
			'number'     => $row['number'],
			'created_at' => multi3d_iso( $row['created_at'] ),
			'expires_at' => multi3d_iso( multi3d_utc_plus_days( MULTI3D_QUOTE_RETENTION_DAYS, $row['created_at'] ) ),
		),
		201
	);
}

function multi3d_rest_list_quotes( WP_REST_Request $request ) {
	global $wpdb;
	$owner = multi3d_bff_owner( $request );
	if ( null === $owner ) {
		return multi3d_json( array( 'quotes' => array() ) );
	}
	$table = multi3d_table( 'quotes' );
	$rows  = $wpdb->get_results(
		$wpdb->prepare(
			"SELECT id, number, status, has_pdf, created_at, expires_at FROM {$table} WHERE owner_hash = %s AND status <> 'reserved' AND (status = 'ordered' OR expires_at IS NULL OR expires_at >= %s) ORDER BY created_at DESC LIMIT 50", // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			$owner,
			multi3d_now_utc()
		),
		ARRAY_A
	);
	$quotes = array();
	foreach ( $rows ? $rows : array() as $row ) {
		$quotes[] = array(
			'id'         => $row['id'],
			'number'     => $row['number'],
			'status'     => $row['status'],
			'has_pdf'    => (bool) (int) $row['has_pdf'],
			'created_at' => multi3d_iso( $row['created_at'] ),
			'expires_at' => multi3d_iso( $row['expires_at'] ),
		);
	}
	return multi3d_json( array( 'quotes' => $quotes ) );
}

function multi3d_rest_store_quote( WP_REST_Request $request ) {
	global $wpdb;
	$row = multi3d_owned_quote( $request['id'], multi3d_bff_owner( $request ) );
	if ( ! $row ) {
		return multi3d_error( 'quote_not_found', 404 );
	}
	if ( 'reserved' !== $row['status'] ) {
		return multi3d_error( 'quote_already_stored', 409 );
	}
	$body       = $request->get_json_params();
	$body       = is_array( $body ) ? $body : array();
	$quote_json = (string) ( $body['quote'] ?? '' );
	$renderings = (string) ( $body['renderings'] ?? '' );
	$quote      = strlen( $quote_json ) <= MULTI3D_QUOTE_MAX_JSON_BYTES ? json_decode( $quote_json, true ) : null;
	if ( ! is_array( $quote ) || 'multi3d-quote' !== ( $quote['format'] ?? '' ) || ( $quote['number'] ?? '' ) !== $row['number'] || ( $body['number'] ?? '' ) !== $row['number'] ) {
		return multi3d_error( 'invalid_quote', 422 );
	}
	// Exactly the configuration the quotation was reserved with (and whose link the PDF prints).
	if ( ! hash_equals( (string) $row['arrangement_sha256'], (string) ( $body['arrangement_sha256'] ?? '' ) ) ) {
		return multi3d_error( 'snapshot_mismatch', 422 );
	}
	$images = strlen( $renderings ) <= MULTI3D_QUOTE_MAX_META_BYTES ? json_decode( $renderings, true ) : null;
	if ( ! is_array( $images ) || count( $images ) < 1 || count( $images ) > MULTI3D_QUOTE_MAX_IMAGES ) {
		return multi3d_error( 'invalid_renderings', 422 );
	}
	$post_id = wp_insert_post(
		array(
			'post_type'   => MULTI3D_QUOTE_POST_TYPE,
			'post_status' => 'private',
			'post_title'  => $row['number'],
		),
		true
	);
	if ( is_wp_error( $post_id ) ) {
		return multi3d_error( 'storage_failed', 500 );
	}
	update_post_meta( $post_id, '_multi3d_quote_id', $row['id'] );
	update_post_meta( $post_id, '_multi3d_quote', wp_slash( wp_json_encode( $quote ) ) );
	update_post_meta( $post_id, '_multi3d_renderings', wp_slash( wp_json_encode( array_values( $images ) ) ) );
	$updated = $wpdb->update(
		multi3d_table( 'quotes' ),
		array(
			'post_id'    => $post_id,
			'status'     => 'stored',
			'expires_at' => multi3d_utc_plus_days( MULTI3D_QUOTE_RETENTION_DAYS, $row['created_at'] ),
		),
		array(
			'id'     => $row['id'],
			'status' => 'reserved',
		)
	);
	if ( 1 !== $updated ) {
		wp_delete_post( $post_id, true ); // A concurrent store won.
		return multi3d_error( 'quote_already_stored', 409 );
	}
	return multi3d_json( array( 'stored' => true ), 201 );
}

function multi3d_rest_store_pdf( WP_REST_Request $request ) {
	global $wpdb;
	$row = multi3d_owned_quote( $request['id'], multi3d_bff_owner( $request ) );
	if ( ! $row || 'reserved' === $row['status'] ) {
		return multi3d_error( 'quote_not_found', 404 );
	}
	if ( (int) $row['has_pdf'] ) {
		return multi3d_json( array( 'stored' => true ) ); // Written once; never replaced.
	}
	$bytes = (string) $request->get_body();
	if ( strlen( $bytes ) > MULTI3D_QUOTE_MAX_PDF_BYTES || 0 !== strpos( $bytes, '%PDF-' ) ) {
		return multi3d_error( 'invalid_pdf', 422 );
	}
	$dir = multi3d_ensure_quote_dir( $row['id'] );
	if ( ! $dir || false === file_put_contents( $dir . '/quote.pdf', $bytes ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions
		return multi3d_error( 'storage_failed', 500 );
	}
	$wpdb->update( multi3d_table( 'quotes' ), array( 'has_pdf' => 1 ), array( 'id' => $row['id'] ) );
	return multi3d_json( array( 'stored' => true ), 201 );
}

function multi3d_rest_get_pdf( WP_REST_Request $request ) {
	$row  = multi3d_owned_quote( $request['id'], multi3d_bff_owner( $request ) );
	$file = $row ? multi3d_quote_dir( $row['id'] ) . '/quote.pdf' : '';
	if ( ! $row || ! (int) $row['has_pdf'] || ! file_exists( $file ) ) {
		return multi3d_error( 'quote_not_found', 404 );
	}
	return new WP_REST_Response( array( '__multi3d_pdf' => $file, 'number' => $row['number'] ), 200 );
}

/** Serves the PDF of multi3d_rest_get_pdf as raw bytes instead of JSON. */
add_filter(
	'rest_pre_serve_request',
	function ( $served, $result, $request ) {
		$data = $result instanceof WP_REST_Response ? $result->get_data() : null;
		if ( $served || ! is_array( $data ) || empty( $data['__multi3d_pdf'] ) || ! preg_match( '#^/multi3d/v1/quotes/[0-9a-f-]{36}/pdf$#', $request->get_route() ) ) {
			return $served;
		}
		header( 'Content-Type: application/pdf' );
		header( 'Content-Length: ' . filesize( $data['__multi3d_pdf'] ) );
		header( 'Cache-Control: private, no-store, max-age=0' );
		header( 'X-Multi3D-Quote-Number: ' . $data['number'] );
		readfile( $data['__multi3d_pdf'] ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		return true;
	},
	10,
	3
);

function multi3d_rest_store_rendering( WP_REST_Request $request ) {
	$row   = multi3d_owned_quote( $request['id'], multi3d_bff_owner( $request ) );
	$index = (int) $request['index'];
	if ( ! $row || 'reserved' === $row['status'] ) {
		return multi3d_error( 'quote_not_found', 404 );
	}
	$renderings = json_decode( (string) get_post_meta( (int) $row['post_id'], '_multi3d_renderings', true ), true );
	if ( $index < 1 || $index > ( is_array( $renderings ) ? count( $renderings ) : 0 ) ) {
		return multi3d_error( 'invalid_index', 422 );
	}
	$dir  = multi3d_ensure_quote_dir( $row['id'] );
	$file = $dir . '/render-' . $index . '.png';
	if ( file_exists( $file ) ) {
		return multi3d_json( array( 'stored' => true ) ); // Written once; never replaced.
	}
	$bytes = (string) $request->get_body();
	if ( strlen( $bytes ) > MULTI3D_QUOTE_MAX_RENDER_BYTES || 0 !== strpos( $bytes, "\x89PNG\r\n\x1a\n" ) ) {
		return multi3d_error( 'invalid_image', 422 );
	}
	if ( ! $dir || false === file_put_contents( $file, $bytes ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions
		return multi3d_error( 'storage_failed', 500 );
	}
	return multi3d_json( array( 'stored' => true ), 201 );
}

function multi3d_rest_email_quote( WP_REST_Request $request ) {
	$owner  = multi3d_bff_owner( $request );
	$row    = multi3d_owned_quote( $request['id'], $owner );
	$params = $request->get_json_params();
	$email  = sanitize_email( (string) ( is_array( $params ) ? ( $params['email'] ?? '' ) : '' ) );
	if ( ! is_email( $email ) ) {
		return multi3d_error( 'invalid_email', 422 );
	}
	$pdf = $row ? multi3d_quote_dir( $row['id'] ) . '/quote.pdf' : '';
	if ( ! $row || ! (int) $row['has_pdf'] || ! file_exists( $pdf ) ) {
		return multi3d_error( 'quote_not_found', 404 );
	}
	if ( multi3d_rate_limited( 'mail_ip', multi3d_bff_client_ip( $request ), MULTI3D_EMAILS_PER_HOUR, HOUR_IN_SECONDS )
		|| multi3d_rate_limited( 'mail_s', $owner, MULTI3D_EMAILS_PER_DAY_SESSION, DAY_IN_SECONDS ) ) {
		return multi3d_error( 'rate_limited', 429 );
	}
	$site    = wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES );
	$subject = sprintf( 'Oferta %s – %s', $row['number'], $site );
	$message = sprintf(
		"Dzień dobry,\n\nw załączniku przesyłamy ofertę %s przygotowaną w konfiguratorze mebli.\nCeny pochodzą ze sklepu w dniu przygotowania oferty; oferta jest przechowywana przez %d dni. Link w ofercie otwiera dokładnie tę konfigurację.\n\n%s\n%s",
		$row['number'],
		MULTI3D_QUOTE_RETENTION_DAYS,
		$site,
		home_url( '/' )
	);
	$sent = wp_mail( $email, $subject, $message, array( 'Content-Type: text/plain; charset=UTF-8' ), array( $pdf ) );
	return $sent ? multi3d_json( array( 'sent' => true ) ) : multi3d_error( 'email_failed', 502 );
}

/** A single-use, one-hour claim for the cart hand-off (only its hash is kept). */
function multi3d_rest_cart_claim( WP_REST_Request $request ) {
	$row = multi3d_owned_quote( $request['id'], multi3d_bff_owner( $request ) );
	if ( ! $row || 'reserved' === $row['status'] ) {
		return multi3d_error( 'quote_not_found', 404 );
	}
	$claim = multi3d_random_token();
	set_transient( 'multi3d_claim_' . hash( 'sha256', $claim ), $row['id'], MULTI3D_CART_CLAIM_SECONDS );
	return multi3d_json( array( 'claim' => $claim ) );
}

/** Takes (and invalidates) a cart claim: the quotation id it was issued for, or null. */
function multi3d_take_cart_claim( $claim ) {
	if ( ! is_string( $claim ) || ! preg_match( MULTI3D_TOKEN_RE, $claim ) ) {
		return null;
	}
	$key = 'multi3d_claim_' . hash( 'sha256', $claim );
	$id  = get_transient( $key );
	delete_transient( $key );
	return is_string( $id ) && preg_match( MULTI3D_UUID_RE, $id ) ? $id : null;
}

add_action(
	'rest_api_init',
	function () {
		$uuid  = '(?P<id>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})';
		$route = function ( $path, $methods, $callback ) {
			register_rest_route(
				'multi3d/v1',
				$path,
				array(
					'methods'             => $methods,
					'callback'            => $callback,
					'permission_callback' => 'multi3d_bff_verify',
				)
			);
		};
		$route( '/quotes', 'POST', 'multi3d_rest_reserve_quote' );
		$route( '/quotes', 'GET', 'multi3d_rest_list_quotes' );
		$route( '/quotes/' . $uuid, 'PUT', 'multi3d_rest_store_quote' );
		$route( '/quotes/' . $uuid . '/pdf', 'POST', 'multi3d_rest_store_pdf' );
		$route( '/quotes/' . $uuid . '/pdf', 'GET', 'multi3d_rest_get_pdf' );
		$route( '/quotes/' . $uuid . '/renderings/(?P<index>[1-3])', 'POST', 'multi3d_rest_store_rendering' );
		$route( '/quotes/' . $uuid . '/email', 'POST', 'multi3d_rest_email_quote' );
		$route( '/quotes/' . $uuid . '/cart-claim', 'POST', 'multi3d_rest_cart_claim' );
	}
);

/** Deletes a quotation row with its record, files and configuration link (not used for ordered ones). */
function multi3d_delete_quote_row( array $row ) {
	global $wpdb;
	if ( ! empty( $row['post_id'] ) ) {
		wp_delete_post( (int) $row['post_id'], true );
	}
	multi3d_delete_quote_files( $row['id'] );
	$wpdb->delete( multi3d_table( 'shared_configs' ), array( 'quote_id' => $row['id'] ) );
	$wpdb->delete( multi3d_table( 'quotes' ), array( 'id' => $row['id'] ) );
}

/**
 * Daily: deletes expired temporary quotations (record, files, configuration link) and abandoned
 * reservations. Ordered quotations, their link and everything their order references are kept.
 */
function multi3d_purge_quotes() {
	global $wpdb;
	$table   = multi3d_table( 'quotes' );
	$expired = $wpdb->get_results(
		$wpdb->prepare( "SELECT * FROM {$table} WHERE status IN ('reserved','stored') AND expires_at < %s LIMIT 500", multi3d_now_utc() ), // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		ARRAY_A
	);
	foreach ( $expired ? $expired : array() as $row ) {
		multi3d_delete_quote_row( $row );
	}

	// Legacy quotations (CPT only, before the quotation table): same 60-day rule as before.
	$legacy = get_posts(
		array(
			'post_type'      => MULTI3D_QUOTE_POST_TYPE,
			'post_status'    => 'any',
			'posts_per_page' => 200,
			'fields'         => 'ids',
			'meta_query'     => array( // phpcs:ignore WordPress.DB.SlowDBQuery
				array(
					'key'   => '_multi3d_quote_status',
					'value' => 'temporary',
				),
				array(
					'key'     => '_multi3d_quote_expires',
					'value'   => time(),
					'compare' => '<',
					'type'    => 'NUMERIC',
				),
			),
		)
	);
	foreach ( $legacy ? $legacy : array() as $post_id ) {
		wp_delete_post( $post_id, true ); // Legacy files: see before_delete_post below.
	}

	// Unreferenced file directories (a failed save, a record deleted without its files), once a day old.
	$dirs = glob( multi3d_quotes_root() . '/*', GLOB_ONLYDIR );
	foreach ( $dirs ? $dirs : array() as $dir ) {
		$key = basename( $dir );
		if ( filemtime( $dir ) >= time() - DAY_IN_SECONDS ) {
			continue;
		}
		if ( preg_match( MULTI3D_UUID_RE, $key ) && ! $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$table} WHERE id = %s", $key ) ) ) { // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
			multi3d_delete_quote_files( $key );
		} elseif ( preg_match( MULTI3D_QUOTE_LEGACY_NUMBER_RE, $key ) && ! multi3d_find_legacy_quote( $key ) ) {
			multi3d_delete_quote_files( $key );
		}
	}
}
add_action( 'multi3d_purge_quotes', 'multi3d_purge_quotes', 10 );

function multi3d_find_legacy_quote( $number ) {
	$posts = get_posts(
		array(
			'post_type'      => MULTI3D_QUOTE_POST_TYPE,
			'post_status'    => 'any',
			'title'          => $number,
			'posts_per_page' => 1,
			'fields'         => 'ids',
		)
	);
	return $posts ? (int) $posts[0] : 0;
}

/** Removes the file directory of a quotation (by id, or legacy number). */
function multi3d_delete_quote_files( $key ) {
	if ( ! preg_match( MULTI3D_UUID_RE, (string) $key ) && ! preg_match( MULTI3D_QUOTE_LEGACY_NUMBER_RE, (string) $key ) ) {
		return;
	}
	$dir   = multi3d_quote_dir( $key );
	$files = glob( $dir . '/*' );
	foreach ( $files ? $files : array() as $file ) {
		wp_delete_file( $file );
	}
	@rmdir( $dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors, WordPress.WP.AlternativeFunctions
}

/** A deleted legacy quotation record (purge or by staff) takes its files with it. */
add_action(
	'before_delete_post',
	function ( $post_id ) {
		if ( get_post_type( $post_id ) === MULTI3D_QUOTE_POST_TYPE && ! get_post_meta( $post_id, '_multi3d_quote_id', true ) ) {
			multi3d_delete_quote_files( get_the_title( $post_id ) );
		}
	}
);

/**
 * Remembers the quotation of the order being placed. The cart form carries a single-use claim issued to
 * the quotation's owner (never a quotation number, which anyone could type).
 */
add_action(
	'multi3d_cart_request',
	function ( array $order ) {
		$id = multi3d_take_cart_claim( $order['quoteClaim'] ?? null );
		if ( $id && WC()->session ) {
			WC()->session->set( 'multi3d_quote_id', $id );
		}
	}
);

/**
 * When the order is placed: the quotation and its configuration link are marked "ordered" (never
 * purged) and the order gets its own copy of the quotation (configuration + agreed pricing snapshot).
 */
add_action(
	'woocommerce_checkout_create_order',
	function ( $order ) {
		global $wpdb;
		$id = WC()->session ? WC()->session->get( 'multi3d_quote_id' ) : null;
		if ( ! is_string( $id ) || ! preg_match( MULTI3D_UUID_RE, $id ) ) {
			return;
		}
		$table = multi3d_table( 'quotes' );
		$row   = $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE id = %s", $id ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
		if ( $row && 'reserved' !== $row['status'] ) {
			$wpdb->update( $table, array( 'status' => 'ordered', 'expires_at' => null ), array( 'id' => $id ) );
			$wpdb->update( multi3d_table( 'shared_configs' ), array( 'status' => 'ordered', 'expires_at' => null ), array( 'quote_id' => $id ) );
			$order->update_meta_data( '_multi3d_quote_id', $id );
			$order->update_meta_data( '_multi3d_quote_number', $row['number'] );
			$order->update_meta_data( '_multi3d_quote', get_post_meta( (int) $row['post_id'], '_multi3d_quote', true ) );
		}
		WC()->session->set( 'multi3d_quote_id', null );
	}
);
