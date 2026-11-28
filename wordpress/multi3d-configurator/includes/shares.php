<?php
/**
 * Shared configurations ("Udostępnij konfigurację"): immutable configuration snapshots behind
 * unguessable links, available for 60 days. BFF-only endpoints (includes/bff.php):
 *
 * - POST /multi3d/v1/shares          {token_hash, snapshot, schema_version} → {id, created_at, expires_at}
 *                                    Stores a new snapshot owned by the calling session.
 * - POST /multi3d/v1/shares/lookup   {token_hash} → {snapshot, created_at, expires_at}; 404 / 410 (expired)
 *                                    Read-only. Never returns the owner, quotation, cart or e-mail data.
 * - POST /multi3d/v1/shares/email    {token_hash, link, email, locale} → {sent}
 *                                    Sends an existing link of the calling session (no new snapshot).
 *                                    The address is not stored.
 *
 * A snapshot is never updated. Opening and changing a shared configuration happens in the recipient's
 * own browser; sharing it again creates a new snapshot with a new token.
 *
 * @package multi3d
 */

defined( 'ABSPATH' ) || exit;

const MULTI3D_SHARE_RETENTION_DAYS    = 60;
const MULTI3D_SHARE_MAX_BYTES         = 524288;
const MULTI3D_SHARES_PER_HOUR_IP      = 30;
const MULTI3D_SHARES_PER_HOUR_SESSION = 20;
const MULTI3D_LOOKUPS_PER_HOUR_IP     = 300;
const MULTI3D_SHARE_EMAILS_PER_HOUR   = 5;
const MULTI3D_SHARE_EMAILS_PER_DAY_SESSION = 10;

/** Validates a snapshot sent by the BFF: well-formed JSON of a known format, within the size limit. */
function multi3d_valid_snapshot( $snapshot ) {
	if ( ! is_string( $snapshot ) || '' === $snapshot || strlen( $snapshot ) > MULTI3D_SHARE_MAX_BYTES ) {
		return false;
	}
	$data = json_decode( $snapshot, true );
	return is_array( $data ) && 'multi3d-configuration-snapshot' === ( $data['format'] ?? '' ) && is_array( $data['arrangement'] ?? null );
}

/**
 * Inserts a snapshot. Returns the new row (array) or null. `$quote_id`: the quotation whose PDF prints
 * this link (its retention then follows the quotation's).
 */
function multi3d_insert_share( $token_hash, $snapshot, $schema_version, $owner, $quote_id = null ) {
	global $wpdb;
	$row = array(
		'id'             => multi3d_uuid4(),
		'token_hash'     => $token_hash,
		'snapshot'       => $snapshot,
		'schema_version' => (int) $schema_version,
		'owner_hash'     => $owner,
		'quote_id'       => $quote_id,
		'status'         => 'active',
		'created_at'     => multi3d_now_utc(),
		'expires_at'     => multi3d_utc_plus_days( MULTI3D_SHARE_RETENTION_DAYS ),
	);
	return false === $wpdb->insert( multi3d_table( 'shared_configs' ), $row ) ? null : $row;
}

function multi3d_find_share_by_hash( $token_hash ) {
	global $wpdb;
	$table = multi3d_table( 'shared_configs' );
	return $wpdb->get_row( $wpdb->prepare( "SELECT * FROM {$table} WHERE token_hash = %s", $token_hash ), ARRAY_A ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
}

function multi3d_share_expired( array $share ) {
	return ! empty( $share['expires_at'] ) && $share['expires_at'] < multi3d_now_utc();
}

function multi3d_rest_create_share( WP_REST_Request $request ) {
	$owner = multi3d_bff_owner( $request );
	if ( null === $owner ) {
		return multi3d_error( 'no_session', 401 );
	}
	$body       = $request->get_json_params();
	$token_hash = is_array( $body ) ? (string) ( $body['token_hash'] ?? '' ) : '';
	$snapshot   = is_array( $body ) ? ( $body['snapshot'] ?? null ) : null;
	$version    = is_array( $body ) ? (int) ( $body['schema_version'] ?? 0 ) : 0;
	if ( ! preg_match( MULTI3D_HASH_RE, $token_hash ) || ! multi3d_valid_snapshot( $snapshot ) || $version < 1 ) {
		return multi3d_error( 'snapshot_invalid', 422 );
	}
	if ( multi3d_rate_limit_request( $request, 'share', MULTI3D_SHARES_PER_HOUR_IP, MULTI3D_SHARES_PER_HOUR_SESSION, HOUR_IN_SECONDS ) ) {
		return multi3d_error( 'rate_limited', 429 );
	}
	$row = multi3d_insert_share( $token_hash, $snapshot, $version, $owner );
	if ( ! $row ) {
		return multi3d_error( 'storage_failed', 500 );
	}
	return multi3d_json(
		array(
			'id'         => $row['id'],
			'created_at' => multi3d_iso( $row['created_at'] ),
			'expires_at' => multi3d_iso( $row['expires_at'] ),
		),
		201
	);
}

function multi3d_rest_lookup_share( WP_REST_Request $request ) {
	$body       = $request->get_json_params();
	$token_hash = is_array( $body ) ? (string) ( $body['token_hash'] ?? '' ) : '';
	if ( multi3d_rate_limited( 'lookup_ip', multi3d_bff_client_ip( $request ), MULTI3D_LOOKUPS_PER_HOUR_IP, HOUR_IN_SECONDS ) ) {
		return multi3d_error( 'rate_limited', 429 );
	}
	$share = preg_match( MULTI3D_HASH_RE, $token_hash ) ? multi3d_find_share_by_hash( $token_hash ) : null;
	if ( ! $share ) {
		return multi3d_error( 'share_not_found', 404 );
	}
	if ( multi3d_share_expired( $share ) ) {
		return multi3d_error( 'share_expired', 410 );
	}
	return multi3d_json(
		array(
			'snapshot'   => $share['snapshot'],
			'created_at' => multi3d_iso( $share['created_at'] ),
			'expires_at' => multi3d_iso( $share['expires_at'] ),
		)
	);
}

function multi3d_rest_email_share( WP_REST_Request $request ) {
	$owner = multi3d_bff_owner( $request );
	if ( null === $owner ) {
		return multi3d_error( 'no_session', 401 );
	}
	$body       = $request->get_json_params();
	$body       = is_array( $body ) ? $body : array();
	$token_hash = (string) ( $body['token_hash'] ?? '' );
	$link       = (string) ( $body['link'] ?? '' );
	$email      = sanitize_email( (string) ( $body['email'] ?? '' ) );
	$locale     = 'en' === ( $body['locale'] ?? '' ) ? 'en' : 'pl';
	if ( ! is_email( $email ) ) {
		return multi3d_error( 'invalid_email', 422 );
	}
	$share = preg_match( MULTI3D_HASH_RE, $token_hash ) ? multi3d_find_share_by_hash( $token_hash ) : null;
	// Only the session that created the link may send it; anyone else gets "not found".
	if ( ! $share || empty( $share['owner_hash'] ) || ! hash_equals( $share['owner_hash'], $owner ) ) {
		return multi3d_error( 'share_not_found', 404 );
	}
	if ( multi3d_share_expired( $share ) ) {
		return multi3d_error( 'share_expired', 410 );
	}
	// The link must be exactly the link of this snapshot (its token hashes to the stored hash).
	if ( ! preg_match( '#^https?://[^\s/?\#]+/c/([A-Za-z0-9_-]{43})$#', $link, $m ) || ! hash_equals( $share['token_hash'], hash( 'sha256', $m[1] ) ) ) {
		return multi3d_error( 'invalid_link', 422 );
	}
	if ( multi3d_rate_limited( 'share_mail_ip', multi3d_bff_client_ip( $request ), MULTI3D_SHARE_EMAILS_PER_HOUR, HOUR_IN_SECONDS )
		|| multi3d_rate_limited( 'share_mail_s', $owner, MULTI3D_SHARE_EMAILS_PER_DAY_SESSION, DAY_IN_SECONDS ) ) {
		return multi3d_error( 'rate_limited', 429 );
	}
	$site    = wp_specialchars_decode( get_bloginfo( 'name' ), ENT_QUOTES );
	$until   = gmdate( 'Y-m-d', strtotime( $share['expires_at'] . ' UTC' ) );
	$subject = 'en' === $locale ? sprintf( 'Furniture configuration – %s', $site ) : sprintf( 'Konfiguracja mebli – %s', $site );
	$message = 'en' === $locale
		? sprintf(
			"Hello,\n\nhere is a link to a furniture configuration prepared in our configurator:\n%s\n\nThe configuration is available for %d days (until %s). Anyone with this link can open it and change their own copy; the original stays unchanged.\nThe link is not a binding price offer: current shop prices are shown when it is opened.\n\n%s\n%s",
			$link,
			MULTI3D_SHARE_RETENTION_DAYS,
			$until,
			$site,
			home_url( '/' )
		)
		: sprintf(
			"Dzień dobry,\n\nprzesyłamy link do konfiguracji mebli przygotowanej w naszym konfiguratorze:\n%s\n\nKonfiguracja jest dostępna przez %d dni (do %s). Każda osoba, która ma ten link, może ją otworzyć i zmieniać własną kopię; oryginał pozostaje bez zmian.\nLink nie jest wiążącą ofertą cenową: przy otwarciu pokazywane są aktualne ceny ze sklepu.\n\n%s\n%s",
			$link,
			MULTI3D_SHARE_RETENTION_DAYS,
			$until,
			$site,
			home_url( '/' )
		);
	$sent = wp_mail( $email, $subject, $message, array( 'Content-Type: text/plain; charset=UTF-8' ) );
	return $sent ? multi3d_json( array( 'sent' => true ) ) : multi3d_error( 'email_failed', 502 );
}

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'multi3d/v1',
			'/shares',
			array(
				'methods'             => 'POST',
				'callback'            => 'multi3d_rest_create_share',
				'permission_callback' => 'multi3d_bff_verify',
			)
		);
		register_rest_route(
			'multi3d/v1',
			'/shares/lookup',
			array(
				'methods'             => 'POST',
				'callback'            => 'multi3d_rest_lookup_share',
				'permission_callback' => 'multi3d_bff_verify',
			)
		);
		register_rest_route(
			'multi3d/v1',
			'/shares/email',
			array(
				'methods'             => 'POST',
				'callback'            => 'multi3d_rest_email_share',
				'permission_callback' => 'multi3d_bff_verify',
			)
		);
	}
);

/** Daily: removes expired shared configurations that belong to no quotation (quotation links: see quotes.php). */
function multi3d_purge_shares() {
	global $wpdb;
	$table = multi3d_table( 'shared_configs' );
	$wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE status = 'active' AND quote_id IS NULL AND expires_at < %s", multi3d_now_utc() ) ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared
}
add_action( 'multi3d_purge_quotes', 'multi3d_purge_shares', 20 );
