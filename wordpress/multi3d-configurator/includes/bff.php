<?php
/**
 * Server-to-server access for the configurator's backend-for-frontend (Next.js route handlers,
 * src/server/wordpress.ts). The customer-specific endpoints of this plugin (quotations, shared
 * configurations, e-mail) accept only requests signed by the BFF, and decide ownership themselves.
 *
 * Required in wp-config.php:
 *     define( 'MULTI3D_BFF_SECRET', '<at least 32 random characters, the same as the BFF>' );
 *
 * Every request carries:
 *   X-Multi3D-Timestamp  Unix time; rejected when more than 5 minutes away from the server clock.
 *   X-Multi3D-Nonce      43-character random value; each nonce is accepted once (replay protection).
 *   X-Multi3D-Session    the customer's anonymous session id (may be empty).
 *   X-Multi3D-Client-IP  the customer's address, for rate limiting.
 *   X-Multi3D-Signature  hex HMAC-SHA256( secret, "multi3d-bff-v1\nMETHOD\nROUTE\nTIMESTAMP\nNONCE\n"
 *                        . sha256(body) . "\nSESSION\nCLIENT_IP" ).
 *
 * The secret only authenticates the BFF. A customer's quotation or shared link is reachable only with
 * the session id whose SHA-256 is stored as its owner: the secret alone grants no access to any
 * customer's data (multi3d_bff_owner()).
 *
 * @package multi3d
 */

defined( 'ABSPATH' ) || exit;

const MULTI3D_BFF_SIGNATURE_VERSION = 'multi3d-bff-v1';
const MULTI3D_BFF_MAX_SKEW          = 300;
const MULTI3D_DB_VERSION            = '2';
const MULTI3D_TOKEN_RE              = '/^[A-Za-z0-9_-]{43}$/';
const MULTI3D_UUID_RE               = '/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/';
const MULTI3D_HASH_RE               = '/^[0-9a-f]{64}$/';

/** permission_callback of every BFF endpoint: true for a valid, fresh, unreplayed signature. */
function multi3d_bff_verify( WP_REST_Request $request ) {
	if ( ! defined( 'MULTI3D_BFF_SECRET' ) || ! is_string( MULTI3D_BFF_SECRET ) || strlen( MULTI3D_BFF_SECRET ) < 32 ) {
		return new WP_Error( 'multi3d_not_configured', 'Not configured.', array( 'status' => 503 ) );
	}
	$timestamp = (string) $request->get_header( 'x_multi3d_timestamp' );
	$nonce     = (string) $request->get_header( 'x_multi3d_nonce' );
	$session   = (string) $request->get_header( 'x_multi3d_session' );
	$client_ip = (string) $request->get_header( 'x_multi3d_client_ip' );
	$signature = (string) $request->get_header( 'x_multi3d_signature' );
	$denied    = new WP_Error( 'multi3d_unauthorized', 'Unauthorized.', array( 'status' => 401 ) );

	if ( ! preg_match( '/^\d{9,11}$/', $timestamp ) || abs( time() - (int) $timestamp ) > MULTI3D_BFF_MAX_SKEW ) {
		return $denied;
	}
	if ( ! preg_match( MULTI3D_TOKEN_RE, $nonce ) || ! preg_match( '/^[0-9a-f]{64}$/', $signature ) ) {
		return $denied;
	}
	if ( '' !== $session && ! preg_match( MULTI3D_TOKEN_RE, $session ) ) {
		return $denied;
	}
	$canonical = implode(
		"\n",
		array(
			MULTI3D_BFF_SIGNATURE_VERSION,
			$request->get_method(),
			$request->get_route(),
			$timestamp,
			$nonce,
			hash( 'sha256', (string) $request->get_body() ),
			$session,
			$client_ip,
		)
	);
	if ( ! hash_equals( hash_hmac( 'sha256', $canonical, MULTI3D_BFF_SECRET ), $signature ) ) {
		return $denied;
	}
	// Each nonce once, for longer than the accepted clock skew.
	$nonce_key = 'multi3d_nonce_' . md5( $nonce );
	if ( false !== get_transient( $nonce_key ) ) {
		return $denied;
	}
	set_transient( $nonce_key, 1, 2 * MULTI3D_BFF_MAX_SKEW );
	return true;
}

/** SHA-256 of the customer's session id (the owner key stored with resources), or null without a session. */
function multi3d_bff_owner( WP_REST_Request $request ) {
	$session = (string) $request->get_header( 'x_multi3d_session' );
	return preg_match( MULTI3D_TOKEN_RE, $session ) ? hash( 'sha256', $session ) : null;
}

function multi3d_bff_client_ip( WP_REST_Request $request ) {
	$ip = (string) $request->get_header( 'x_multi3d_client_ip' );
	return preg_match( '/^[0-9a-fA-F:.]{2,45}$/', $ip ) ? $ip : 'unknown';
}

/**
 * Fixed-window counter: true when `$key` already used `$limit` requests of the bucket in the window
 * (the request is then refused and not counted).
 */
function multi3d_rate_limited( $bucket, $key, $limit, $window ) {
	$transient = 'multi3d_rl_' . $bucket . '_' . md5( (string) $key );
	$count     = (int) get_transient( $transient );
	if ( $count >= $limit ) {
		return true;
	}
	set_transient( $transient, $count + 1, $window );
	return false;
}

/** Rate-limits a request by client address and (when present) by session. */
function multi3d_rate_limit_request( WP_REST_Request $request, $bucket, $per_ip, $per_session, $window ) {
	if ( multi3d_rate_limited( $bucket . '_ip', multi3d_bff_client_ip( $request ), $per_ip, $window ) ) {
		return true;
	}
	$owner = multi3d_bff_owner( $request );
	return null !== $owner && multi3d_rate_limited( $bucket . '_s', $owner, $per_session, $window );
}

function multi3d_json( $data, $status = 200 ) {
	$response = new WP_REST_Response( $data, $status );
	$response->header( 'Cache-Control', 'private, no-store, max-age=0' );
	return $response;
}

function multi3d_error( $code, $status ) {
	return multi3d_json( array( 'code' => $code ), $status );
}

/** Cryptographically secure UUID v4 (wp_generate_uuid4() uses mt_rand). */
function multi3d_uuid4() {
	$bytes    = random_bytes( 16 );
	$bytes[6] = chr( ( ord( $bytes[6] ) & 0x0f ) | 0x40 );
	$bytes[8] = chr( ( ord( $bytes[8] ) & 0x3f ) | 0x80 );
	$hex      = bin2hex( $bytes );
	return sprintf( '%s-%s-%s-%s-%s', substr( $hex, 0, 8 ), substr( $hex, 8, 4 ), substr( $hex, 12, 4 ), substr( $hex, 16, 4 ), substr( $hex, 20 ) );
}

/** 256 random bits, base64url without padding (43 characters). */
function multi3d_random_token() {
	return rtrim( strtr( base64_encode( random_bytes( 32 ) ), '+/', '-_' ), '=' );
}

function multi3d_now_utc() {
	return gmdate( 'Y-m-d H:i:s' );
}

function multi3d_utc_plus_days( $days, $from = null ) {
	return gmdate( 'Y-m-d H:i:s', ( null === $from ? time() : strtotime( $from . ' UTC' ) ) + (int) $days * DAY_IN_SECONDS );
}

/** "2026-11-24 10:00:00" (UTC) → ISO 8601. */
function multi3d_iso( $utc ) {
	return $utc ? gmdate( 'c', strtotime( $utc . ' UTC' ) ) : null;
}

function multi3d_table( $name ) {
	global $wpdb;
	return $wpdb->prefix . 'multi3d_' . $name;
}

/**
 * Tables (WordPress prefix, InnoDB):
 * - multi3d_quotes: quotations of the configurator. Internal id (UUID v4), human-readable number with a
 *   unique index, owner (SHA-256 of the session id), the CPT record holding the documents, status and
 *   retention. Legacy quotations (CPT only, before this table) have no row and no owner.
 * - multi3d_shared_configs: immutable configuration snapshots behind shared links. Only the SHA-256 of
 *   the link token is stored (unique index), never the token.
 */
function multi3d_install_schema() {
	global $wpdb;
	require_once ABSPATH . 'wp-admin/includes/upgrade.php';
	$charset = $wpdb->get_charset_collate();
	$quotes  = multi3d_table( 'quotes' );
	$shares  = multi3d_table( 'shared_configs' );
	dbDelta(
		"CREATE TABLE {$quotes} (
  id char(36) NOT NULL,
  number varchar(24) NOT NULL,
  owner_hash char(64) NOT NULL,
  post_id bigint(20) unsigned DEFAULT NULL,
  share_id char(36) DEFAULT NULL,
  arrangement_sha256 char(64) NOT NULL,
  status varchar(16) NOT NULL,
  has_pdf tinyint(1) NOT NULL DEFAULT 0,
  created_at datetime NOT NULL,
  expires_at datetime DEFAULT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY number (number),
  KEY owner_hash (owner_hash),
  KEY status_expires (status,expires_at)
) ENGINE=InnoDB {$charset};"
	);
	dbDelta(
		"CREATE TABLE {$shares} (
  id char(36) NOT NULL,
  token_hash char(64) NOT NULL,
  snapshot longtext NOT NULL,
  schema_version smallint(5) unsigned NOT NULL,
  owner_hash char(64) DEFAULT NULL,
  quote_id char(36) DEFAULT NULL,
  status varchar(16) NOT NULL,
  created_at datetime NOT NULL,
  expires_at datetime DEFAULT NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY token_hash (token_hash),
  KEY owner_hash (owner_hash),
  KEY quote_id (quote_id),
  KEY status_expires (status,expires_at)
) ENGINE=InnoDB {$charset};"
	);
	update_option( 'multi3d_db_version', MULTI3D_DB_VERSION, false );
}

add_action(
	'plugins_loaded',
	function () {
		if ( get_option( 'multi3d_db_version' ) !== MULTI3D_DB_VERSION ) {
			multi3d_install_schema();
		}
	}
);
