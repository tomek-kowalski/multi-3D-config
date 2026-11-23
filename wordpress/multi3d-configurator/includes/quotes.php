<?php
/**
 * Quotations ("Drukuj ofertę") for the multi-furniture configurator.
 *
 * - POST /wp-json/multi3d/v1/quotes                 stores a quotation: the quotation JSON (complete
 *   configuration + pricing snapshot) and the rendering metadata (mode, samples, settings, camera) as
 *   post meta, the PDF as a file in uploads/multi3d-quotes/<number>/ (no binaries in the database).
 * - POST /wp-json/multi3d/v1/quotes/<number>/renderings/<n>  stores rendering n (raw PNG body) as
 *   render-<n>.png next to the PDF. Each rendering is written once (repeated uploads are ignored).
 * - POST /wp-json/multi3d/v1/quotes/<number>/email  sends the stored PDF with wp_mail.
 * - Temporary quotations expire after MULTI3D_QUOTE_RETENTION_DAYS (daily WP-Cron purge). A quotation
 *   that became an order is marked "ordered" and kept; the order also gets its own copy. The purge also
 *   removes file directories that no quotation references any more (failed saves, deleted records).
 *
 * The endpoints are public (the configurator has no login). They only accept well-formed data within
 * size limits, only ever e-mail the stored PDF of an existing quotation, and the e-mail endpoint is
 * rate-limited per IP address.
 *
 * @package multi3d
 */

defined( 'ABSPATH' ) || exit;

const MULTI3D_QUOTE_POST_TYPE       = 'multi3d_quote';
const MULTI3D_QUOTE_RETENTION_DAYS  = 60;
const MULTI3D_QUOTE_MAX_PDF_BYTES   = 8388608;
const MULTI3D_QUOTE_MAX_RENDER_BYTES = 12582912; // PHP post_max_size must allow this (1920x1080 PNG: ~2-6 MB).
const MULTI3D_QUOTE_MAX_IMAGES      = 3;
const MULTI3D_QUOTE_MAX_META_BYTES  = 16384;
const MULTI3D_EMAILS_PER_HOUR       = 5;
const MULTI3D_QUOTE_NUMBER_RE       = '/^OF-\d{8}-[A-Z0-9]{4}$/';

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

function multi3d_quote_dir( $number ) {
	$uploads = wp_upload_dir();
	return trailingslashit( $uploads['basedir'] ) . 'multi3d-quotes/' . $number;
}

function multi3d_find_quote( $number ) {
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

/** Decodes a base64 payload (optionally with one of the data-URL prefixes) within a size limit, or null. */
function multi3d_decode_file( $data, $prefixes, $max_bytes ) {
	if ( ! is_string( $data ) ) {
		return null;
	}
	foreach ( $prefixes as $prefix ) {
		if ( 0 === strpos( $data, $prefix ) ) {
			$data = substr( $data, strlen( $prefix ) );
			break;
		}
	}
	if ( strlen( $data ) > ( $max_bytes * 4 / 3 ) + 4 ) {
		return null;
	}
	$bytes = base64_decode( $data, true );
	return ( false === $bytes || strlen( $bytes ) > $max_bytes ) ? null : $bytes;
}

function multi3d_rest_save_quote( WP_REST_Request $request ) {
	$body   = $request->get_json_params();
	$number = is_array( $body ) ? (string) ( $body['number'] ?? '' ) : '';
	if ( ! preg_match( MULTI3D_QUOTE_NUMBER_RE, $number ) || ! is_array( $body['quote'] ?? null ) ) {
		return new WP_REST_Response( array( 'code' => 'invalid_quote' ), 400 );
	}
	$quote = $body['quote'];
	if ( ( $quote['format'] ?? '' ) !== 'multi3d-quote' || ( $quote['number'] ?? '' ) !== $number ) {
		return new WP_REST_Response( array( 'code' => 'invalid_quote' ), 400 );
	}
	if ( multi3d_find_quote( $number ) ) {
		return new WP_REST_Response( array( 'number' => $number ), 200 ); // Already stored (idempotent).
	}
	$pdf = multi3d_decode_file( $body['pdf'] ?? null, array( 'data:application/pdf;base64,' ), MULTI3D_QUOTE_MAX_PDF_BYTES );
	if ( null === $pdf || 0 !== strpos( $pdf, '%PDF-' ) ) {
		return new WP_REST_Response( array( 'code' => 'invalid_pdf' ), 400 );
	}
	// How each rendering was made (photorealistic or raster fallback, samples, settings, camera).
	$renderings      = is_array( $body['renderings'] ?? null ) ? array_values( $body['renderings'] ) : array();
	$renderings_json = wp_json_encode( $renderings );
	if ( count( $renderings ) < 1 || count( $renderings ) > MULTI3D_QUOTE_MAX_IMAGES || strlen( (string) $renderings_json ) > MULTI3D_QUOTE_MAX_META_BYTES ) {
		return new WP_REST_Response( array( 'code' => 'invalid_renderings' ), 400 );
	}

	$dir = multi3d_quote_dir( $number );
	if ( ! wp_mkdir_p( $dir ) ) {
		return new WP_REST_Response( array( 'code' => 'storage_failed' ), 500 );
	}
	// The files are only e-mailed or opened by staff; never served publicly.
	$root = dirname( $dir );
	if ( ! file_exists( $root . '/.htaccess' ) ) {
		file_put_contents( $root . '/.htaccess', "Require all denied\nDeny from all\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions
		file_put_contents( $root . '/index.php', "<?php // Silence.\n" ); // phpcs:ignore WordPress.WP.AlternativeFunctions
	}
	file_put_contents( $dir . '/quote.pdf', $pdf ); // phpcs:ignore WordPress.WP.AlternativeFunctions

	$post_id = wp_insert_post(
		array(
			'post_type'   => MULTI3D_QUOTE_POST_TYPE,
			'post_status' => 'private',
			'post_title'  => $number,
		),
		true
	);
	if ( is_wp_error( $post_id ) ) {
		return new WP_REST_Response( array( 'code' => 'storage_failed' ), 500 );
	}
	update_post_meta( $post_id, '_multi3d_quote', wp_slash( wp_json_encode( $quote ) ) );
	update_post_meta( $post_id, '_multi3d_renderings', wp_slash( $renderings_json ) );
	update_post_meta( $post_id, '_multi3d_quote_status', 'temporary' );
	update_post_meta( $post_id, '_multi3d_quote_expires', time() + MULTI3D_QUOTE_RETENTION_DAYS * DAY_IN_SECONDS );
	return new WP_REST_Response( array( 'number' => $number ), 201 );
}

/** Stores one PNG rendering of a stored quotation (raw request body). */
function multi3d_rest_save_rendering( WP_REST_Request $request ) {
	$number  = (string) $request['number'];
	$index   = (int) $request['index'];
	$post_id = preg_match( MULTI3D_QUOTE_NUMBER_RE, $number ) ? multi3d_find_quote( $number ) : 0;
	if ( ! $post_id ) {
		return new WP_REST_Response( array( 'code' => 'quote_not_found' ), 404 );
	}
	$renderings = json_decode( (string) get_post_meta( $post_id, '_multi3d_renderings', true ), true );
	if ( $index < 1 || $index > ( is_array( $renderings ) ? count( $renderings ) : 0 ) ) {
		return new WP_REST_Response( array( 'code' => 'invalid_index' ), 400 );
	}
	$file = multi3d_quote_dir( $number ) . '/render-' . $index . '.png';
	if ( file_exists( $file ) ) {
		return new WP_REST_Response( array( 'stored' => true ), 200 ); // Written once; never replaced.
	}
	$bytes = $request->get_body();
	if ( ! is_string( $bytes ) || strlen( $bytes ) > MULTI3D_QUOTE_MAX_RENDER_BYTES || 0 !== strpos( $bytes, "\x89PNG\r\n\x1a\n" ) ) {
		return new WP_REST_Response( array( 'code' => 'invalid_image' ), 400 );
	}
	if ( false === file_put_contents( $file, $bytes ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions
		return new WP_REST_Response( array( 'code' => 'storage_failed' ), 500 );
	}
	return new WP_REST_Response( array( 'stored' => true ), 201 );
}

function multi3d_rest_email_quote( WP_REST_Request $request ) {
	$number = (string) $request['number'];
	$params = $request->get_json_params();
	$email  = sanitize_email( (string) ( is_array( $params ) ? ( $params['email'] ?? '' ) : '' ) );
	if ( ! preg_match( MULTI3D_QUOTE_NUMBER_RE, $number ) || ! is_email( $email ) ) {
		return new WP_REST_Response( array( 'code' => 'invalid_request' ), 400 );
	}
	$post_id = multi3d_find_quote( $number );
	$pdf     = multi3d_quote_dir( $number ) . '/quote.pdf';
	if ( ! $post_id || ! file_exists( $pdf ) ) {
		return new WP_REST_Response( array( 'code' => 'quote_not_found' ), 404 );
	}
	$ip_key = 'multi3d_mail_' . md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? '' ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput
	$count  = (int) get_transient( $ip_key );
	if ( $count >= MULTI3D_EMAILS_PER_HOUR ) {
		return new WP_REST_Response( array( 'code' => 'rate_limited' ), 429 );
	}
	set_transient( $ip_key, $count + 1, HOUR_IN_SECONDS );

	$site    = wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES );
	$subject = sprintf( 'Oferta %s – %s', $number, $site );
	$message = sprintf(
		"Dzień dobry,\n\nw załączniku przesyłamy ofertę %s przygotowaną w konfiguratorze mebli.\nCeny pochodzą ze sklepu w dniu przygotowania oferty; oferta jest przechowywana przez %d dni.\n\n%s\n%s",
		$number,
		MULTI3D_QUOTE_RETENTION_DAYS,
		$site,
		home_url( '/' )
	);
	$sent = wp_mail( $email, $subject, $message, array( 'Content-Type: text/plain; charset=UTF-8' ), array( $pdf ) );
	return new WP_REST_Response( array( 'sent' => (bool) $sent ), $sent ? 200 : 502 );
}

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'multi3d/v1',
			'/quotes',
			array(
				'methods'             => 'POST',
				'callback'            => 'multi3d_rest_save_quote',
				'permission_callback' => '__return_true',
			)
		);
		register_rest_route(
			'multi3d/v1',
			'/quotes/(?P<number>OF-\d{8}-[A-Z0-9]{4})/renderings/(?P<index>[1-3])',
			array(
				'methods'             => 'POST',
				'callback'            => 'multi3d_rest_save_rendering',
				'permission_callback' => '__return_true',
			)
		);
		register_rest_route(
			'multi3d/v1',
			'/quotes/(?P<number>OF-\d{8}-[A-Z0-9]{4})/email',
			array(
				'methods'             => 'POST',
				'callback'            => 'multi3d_rest_email_quote',
				'permission_callback' => '__return_true',
			)
		);
		if ( defined( 'MULTI3D_ALLOWED_ORIGIN' ) ) {
			add_filter(
				'rest_pre_serve_request',
				function ( $served, $result, $request ) {
					if ( 0 === strpos( $request->get_route(), '/multi3d/v1/' ) ) {
						header( 'Access-Control-Allow-Origin: ' . esc_url_raw( MULTI3D_ALLOWED_ORIGIN ) );
						header( 'Access-Control-Allow-Methods: POST, OPTIONS' );
						header( 'Access-Control-Allow-Headers: Content-Type' );
						header( 'Vary: Origin', false );
					}
					return $served;
				},
				10,
				3
			);
		}
	}
);

/** Daily: deletes expired temporary quotations (files and record). Ordered quotations are kept. */
add_action(
	'multi3d_purge_quotes',
	function () {
		$expired = get_posts(
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
		foreach ( $expired as $post_id ) {
			wp_delete_post( $post_id, true ); // Files: see before_delete_post below.
		}
		// Unreferenced file directories (a save that failed after writing files, a record deleted
		// without its files): removed once they are a day old.
		$root = dirname( multi3d_quote_dir( 'x' ) );
		$dirs = glob( $root . '/OF-*', GLOB_ONLYDIR );
		foreach ( $dirs ? $dirs : array() as $dir ) {
			$number = basename( $dir );
			if ( preg_match( MULTI3D_QUOTE_NUMBER_RE, $number ) && ! multi3d_find_quote( $number ) && filemtime( $dir ) < time() - DAY_IN_SECONDS ) {
				multi3d_delete_quote_files( $number );
			}
		}
	}
);

function multi3d_delete_quote_files( $number ) {
	if ( ! preg_match( MULTI3D_QUOTE_NUMBER_RE, $number ) ) {
		return;
	}
	$dir   = multi3d_quote_dir( $number );
	$files = glob( $dir . '/*' );
	foreach ( $files ? $files : array() as $file ) {
		wp_delete_file( $file );
	}
	@rmdir( $dir ); // phpcs:ignore WordPress.PHP.NoSilencedErrors, WordPress.WP.AlternativeFunctions
}

/** A deleted quotation record (purge or by staff) takes its files with it. */
add_action(
	'before_delete_post',
	function ( $post_id ) {
		if ( get_post_type( $post_id ) === MULTI3D_QUOTE_POST_TYPE ) {
			multi3d_delete_quote_files( get_the_title( $post_id ) );
		}
	}
);

/** Remembers the quotation of the order being placed (sent with the cart hand-off). */
add_action(
	'multi3d_cart_request',
	function ( array $order ) {
		$number = (string) ( $order['quoteNumber'] ?? '' );
		if ( preg_match( MULTI3D_QUOTE_NUMBER_RE, $number ) && WC()->session ) {
			WC()->session->set( 'multi3d_quote_number', $number );
		}
	}
);

/**
 * When the order is placed: the quotation is marked "ordered" (never purged) and the order gets its own
 * copy of the quotation (configuration + agreed pricing snapshot), independent of the quotation record.
 */
add_action(
	'woocommerce_checkout_create_order',
	function ( $order ) {
		$number = WC()->session ? WC()->session->get( 'multi3d_quote_number' ) : null;
		if ( ! is_string( $number ) || ! preg_match( MULTI3D_QUOTE_NUMBER_RE, $number ) ) {
			return;
		}
		$post_id = multi3d_find_quote( $number );
		if ( $post_id ) {
			update_post_meta( $post_id, '_multi3d_quote_status', 'ordered' );
			delete_post_meta( $post_id, '_multi3d_quote_expires' );
			$order->update_meta_data( '_multi3d_quote_number', $number );
			$order->update_meta_data( '_multi3d_quote', get_post_meta( $post_id, '_multi3d_quote', true ) );
		}
		WC()->session->set( 'multi3d_quote_number', null );
	}
);
