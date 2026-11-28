<?php
/**
 * Security and lifecycle tests of the multi3d-configurator plugin, run against the WordPress stub
 * (test/php/wp-stub.php, SQLite). Usage: php test/php/plugin-tests.php
 *
 * TEST CODE ONLY — never deployed.
 */

$db      = tempnam( sys_get_temp_dir(), 'multi3d-db-' );
$uploads = sys_get_temp_dir() . '/multi3d-uploads-' . bin2hex( random_bytes( 4 ) );
putenv( "MULTI3D_TEST_DB={$db}" );
putenv( "MULTI3D_TEST_UPLOADS={$uploads}" );
require __DIR__ . '/wp-stub.php';
stub_boot_plugin();

// ---------------------------------------------------------------- mini test framework

$failures = 0;
$passed   = 0;
function check( $condition, $message ) {
	global $failures, $passed;
	if ( $condition ) {
		++$passed;
		return;
	}
	++$failures;
	$trace = debug_backtrace()[0];
	fwrite( STDERR, "  FAIL: {$message} (line {$trace['line']})\n" );
}
function same( $expected, $actual, $message ) {
	check( $expected === $actual, $message . ' — expected ' . var_export( $expected, true ) . ', got ' . var_export( $actual, true ) );
}
function test( $name, callable $fn ) {
	global $wpdb;
	// Each test starts without rate-limit counters or used nonces.
	$wpdb->query( "DELETE FROM wp_options WHERE option_name LIKE '_transient_multi3d_rl_%' OR option_name LIKE '_transient_multi3d_nonce_%'" );
	echo "- {$name}\n";
	$fn();
}

function token() {
	return multi3d_random_token();
}

/** A request as the BFF signs it (src/server/wordpress.ts). */
function signed( $method, $route, $session = '', $body = '', array $override = array() ) {
	$timestamp = (string) ( $override['timestamp'] ?? time() );
	$nonce     = $override['nonce'] ?? token();
	$ip        = $override['ip'] ?? '198.51.100.10';
	$secret    = $override['secret'] ?? MULTI3D_BFF_SECRET;
	$canonical = implode( "\n", array( 'multi3d-bff-v1', $method, $override['signed_route'] ?? $route, $timestamp, $nonce, hash( 'sha256', $override['signed_body'] ?? $body ), $override['signed_session'] ?? $session, $ip ) );
	return new WP_REST_Request(
		$method,
		$route,
		array(
			'X-Multi3D-Timestamp' => $timestamp,
			'X-Multi3D-Nonce'     => $nonce,
			'X-Multi3D-Session'   => $session,
			'X-Multi3D-Client-IP' => $ip,
			'X-Multi3D-Signature' => hash_hmac( 'sha256', $canonical, $secret ),
		),
		$body
	);
}

function call( $method, $route, $session = '', $json = null, array $override = array() ) {
	$body = is_string( $json ) ? $json : ( null === $json ? '' : json_encode( $json ) );
	return stub_rest_dispatch( signed( $method, $route, $session, $body, $override ) );
}

function snapshot_json( $width = 4000 ) {
	return json_encode(
		array(
			'format'        => 'multi3d-configuration-snapshot',
			'schemaVersion' => 1,
			'arrangement'   => array( 'format' => 'multi3d-arrangement', 'schemaVersion' => 1, 'room' => array( 'width' => $width ), 'modules' => array() ),
			'presentation'  => new stdClass(),
		)
	);
}

function share_payload( $token, $width = 4000 ) {
	return array( 'token_hash' => hash( 'sha256', $token ), 'snapshot' => snapshot_json( $width ), 'schema_version' => 1 );
}

function reserve( $session, $sha = null, $token = null ) {
	$response = call( 'POST', '/multi3d/v1/quotes', $session, array( 'arrangement_sha256' => $sha ?? str_repeat( 'a', 64 ), 'share' => share_payload( $token ?? token() ) ) );
	return $response;
}

function store_quote( $session, $id, $number, $sha = null ) {
	return call(
		'PUT',
		"/multi3d/v1/quotes/{$id}",
		$session,
		array(
			'number'             => $number,
			'quote'              => json_encode( array( 'format' => 'multi3d-quote', 'number' => $number, 'total' => 100 ) ),
			'renderings'         => json_encode( array( array( 'view' => 'front' ) ) ),
			'arrangement_sha256' => $sha ?? str_repeat( 'a', 64 ),
		)
	);
}

function full_quote( $session ) {
	$r = reserve( $session );
	$q = $r->get_data();
	store_quote( $session, $q['id'], $q['number'] );
	call( 'POST', "/multi3d/v1/quotes/{$q['id']}/pdf", $session, "%PDF-1.7 test quote {$q['number']}" );
	return $q;
}

function rows( $table, $where = '1=1' ) {
	global $wpdb;
	return $wpdb->get_results( 'SELECT * FROM ' . multi3d_table( $table ) . " WHERE {$where}" );
}

function mails() {
	global $wpdb;
	return $wpdb->get_results( 'SELECT * FROM stub_mail ORDER BY id' );
}

$A = token();
$B = token();

// ---------------------------------------------------------------- schema

test(
	'installs the tables with unique indexes for quotation numbers and token hashes',
	function () {
		global $wpdb;
		same( '2', get_option( 'multi3d_db_version' ), 'schema version recorded' );
		$row = array( 'id' => multi3d_uuid4(), 'number' => 'OF-20260101-AAAAAA', 'owner_hash' => str_repeat( 'b', 64 ), 'arrangement_sha256' => str_repeat( 'c', 64 ), 'status' => 'reserved', 'created_at' => multi3d_now_utc() );
		check( false !== $wpdb->insert( multi3d_table( 'quotes' ), $row ), 'first insert' );
		$row['id'] = multi3d_uuid4();
		check( false === $wpdb->insert( multi3d_table( 'quotes' ), $row ), 'duplicate number rejected by the database' );
		check( multi3d_is_duplicate_key_error( $wpdb->last_error ), 'reported as a duplicate key' );
		$wpdb->delete( multi3d_table( 'quotes' ), array( 'number' => 'OF-20260101-AAAAAA' ) );
		check( (bool) preg_match( MULTI3D_UUID_RE, multi3d_uuid4() ), 'UUID v4 format' );
	}
);

// ---------------------------------------------------------------- server-to-server authentication

test(
	'accepts only fresh, unreplayed requests signed with the shared secret',
	function () use ( $A ) {
		same( 200, call( 'GET', '/multi3d/v1/quotes', $A )->get_status(), 'valid signature' );
		same( 401, call( 'GET', '/multi3d/v1/quotes', $A, null, array( 'secret' => str_repeat( 'x', 40 ) ) )->get_status(), 'wrong secret' );
		same( 401, call( 'POST', '/multi3d/v1/shares', $A, share_payload( token() ), array( 'signed_body' => '{}' ) )->get_status(), 'altered body' );
		same( 401, call( 'GET', '/multi3d/v1/quotes', $A, null, array( 'signed_route' => '/multi3d/v1/shares' ) )->get_status(), 'other route' );
		same( 401, call( 'GET', '/multi3d/v1/quotes', $A, null, array( 'signed_session' => token() ) )->get_status(), 'swapped session' );
		same( 401, call( 'GET', '/multi3d/v1/quotes', $A, null, array( 'timestamp' => time() - 400 ) )->get_status(), 'stale timestamp' );
		$nonce = token();
		same( 200, call( 'GET', '/multi3d/v1/quotes', $A, null, array( 'nonce' => $nonce ) )->get_status(), 'first use of a nonce' );
		same( 401, call( 'GET', '/multi3d/v1/quotes', $A, null, array( 'nonce' => $nonce ) )->get_status(), 'replayed nonce' );
		$unsigned = new WP_REST_Request( 'POST', '/multi3d/v1/quotes', array(), '{}' );
		same( 401, stub_rest_dispatch( $unsigned )->get_status(), 'unsigned request' );
	}
);

test(
	'the former public quotation endpoints no longer exist; legacy quotations stay unreachable and unowned',
	function () use ( $A ) {
		global $wpdb;
		$legacy = wp_insert_post( array( 'post_type' => 'multi3d_quote', 'post_status' => 'private', 'post_title' => 'OF-20261001-ABCD' ) );
		update_post_meta( $legacy, '_multi3d_quote', '{"format":"multi3d-quote","number":"OF-20261001-ABCD"}' );
		update_post_meta( $legacy, '_multi3d_quote_status', 'temporary' );
		update_post_meta( $legacy, '_multi3d_quote_expires', time() + 86400 );
		// Old public calls (unsigned, by number).
		$old_email = new WP_REST_Request( 'POST', '/multi3d/v1/quotes/OF-20261001-ABCD/email', array( 'Content-Type' => 'application/json' ), '{"email":"x@y.pl"}' );
		same( 404, stub_rest_dispatch( $old_email )->get_status(), 'old e-mail endpoint gone' );
		$old_render = new WP_REST_Request( 'POST', '/multi3d/v1/quotes/OF-20261001-ABCD/renderings/1', array(), "\x89PNG\r\n\x1a\n" );
		same( 404, stub_rest_dispatch( $old_render )->get_status(), 'old rendering endpoint gone' );
		// Even a correctly signed request cannot address a quotation by number.
		same( 404, call( 'POST', '/multi3d/v1/quotes/OF-20261001-ABCD/email', $A, array( 'email' => 'x@y.pl' ) )->get_status(), 'number is not an identifier' );
		// No session lists or owns it.
		$listed = call( 'GET', '/multi3d/v1/quotes', $A )->get_data();
		check( ! in_array( 'OF-20261001-ABCD', array_column( $listed['quotes'], 'number' ), true ), 'not listed for any session' );
		same( 0, (int) $wpdb->get_var( 'SELECT COUNT(*) FROM ' . multi3d_table( 'quotes' ) . " WHERE number = 'OF-20261001-ABCD'" ), 'no ownership row was created' );
		same( 0, count( mails() ), 'nothing was e-mailed' );
	}
);

// ---------------------------------------------------------------- quotations: numbers, ownership

test(
	'reserves quotations with a UUID and a unique number; number collisions are retried in the transaction',
	function () use ( $A ) {
		$first = reserve( $A )->get_data();
		check( (bool) preg_match( MULTI3D_UUID_RE, $first['id'] ), 'internal id is a UUID v4' );
		check( (bool) preg_match( '/^OF-\d{8}-[A-Z2-9]{6}$/', $first['number'] ), 'human-readable number' );
		$collisions = array();
		add_action( 'multi3d_quote_number_collision', function ( $n ) use ( &$collisions ) { $collisions[] = $n; } );
		// The next two candidates collide with the existing number; the third is free.
		add_filter( 'multi3d_quote_number', fn( $number, $attempt ) => $attempt < 2 ? $first['number'] : $number, 10, 2 );
		$second = reserve( $A );
		same( 201, $second->get_status(), 'reserved despite collisions' );
		check( $second->get_data()['number'] !== $first['number'], 'a different number' );
		same( array( $first['number'], $first['number'] ), $collisions, 'two collisions handled' );
		same( 1, count( rows( 'quotes', "number = '{$first['number']}'" ) ), 'number still unique' );

		// Every candidate collides: the reservation fails and leaves nothing behind (rollback).
		remove_all_filters( 'multi3d_quote_number' );
		add_filter( 'multi3d_quote_number', fn( $number ) => $first['number'], 10, 2 );
		$token  = token();
		$before = array( count( rows( 'quotes' ) ), count( rows( 'shared_configs' ) ) );
		same( 500, reserve( $A, null, $token )->get_status(), 'exhausted attempts' );
		same( $before, array( count( rows( 'quotes' ) ), count( rows( 'shared_configs' ) ) ), 'no orphan rows' );
		same( 0, count( rows( 'shared_configs', "token_hash = '" . hash( 'sha256', $token ) . "'" ) ), 'snapshot rolled back' );
		remove_all_filters( 'multi3d_quote_number' );
		remove_all_filters( 'multi3d_quote_number_collision' );
	}
);

test(
	'a failure after the quotation row rolls the whole reservation back (duplicate token hash)',
	function () use ( $A ) {
		$token  = token();
		same( 201, reserve( $A, null, $token )->get_status(), 'first' );
		$before = count( rows( 'quotes' ) );
		same( 500, reserve( $A, null, $token )->get_status(), 'same token hash rejected' );
		same( $before, count( rows( 'quotes' ) ), 'quotation row rolled back' );
	}
);

test(
	'only the owning session can store, read, e-mail or claim a quotation (the secret alone is not enough)',
	function () use ( $A, $B ) {
		$q  = reserve( $A )->get_data();
		$id = $q['id'];
		same( 404, store_quote( $B, $id, $q['number'] )->get_status(), 'B cannot store A\'s quotation' );
		same( 404, store_quote( '', $id, $q['number'] )->get_status(), 'no session cannot either' );
		same( 201, store_quote( $A, $id, $q['number'] )->get_status(), 'A stores it' );
		same( 404, call( 'POST', "/multi3d/v1/quotes/{$id}/pdf", $B, '%PDF-1.7 forged' )->get_status(), 'B cannot upload the PDF' );
		same( 201, call( 'POST', "/multi3d/v1/quotes/{$id}/pdf", $A, '%PDF-1.7 genuine' )->get_status(), 'A uploads the PDF' );
		same( 404, call( 'GET', "/multi3d/v1/quotes/{$id}/pdf", $B )->get_status(), 'B cannot read the PDF' );
		same( 200, call( 'GET', "/multi3d/v1/quotes/{$id}/pdf", $A )->get_status(), 'A reads the PDF' );
		same( 404, call( 'POST', "/multi3d/v1/quotes/{$id}/email", $B, array( 'email' => 'attacker@example.com' ) )->get_status(), 'B cannot e-mail it' );
		same( 404, call( 'POST', "/multi3d/v1/quotes/{$id}/cart-claim", $B )->get_status(), 'B cannot claim it' );
		same( 404, call( 'POST', "/multi3d/v1/quotes/{$id}/renderings/1", $B, "\x89PNG\r\n\x1a\nX" )->get_status(), 'B cannot add renderings' );
		$listed_b = call( 'GET', '/multi3d/v1/quotes', $B )->get_data()['quotes'];
		check( ! in_array( $id, array_column( $listed_b, 'id' ), true ), 'not in B\'s list' );
		$listed_a = call( 'GET', '/multi3d/v1/quotes', $A )->get_data()['quotes'];
		check( in_array( $id, array_column( $listed_a, 'id' ), true ), 'in A\'s list' );
		same( 0, count( array_filter( mails(), fn( $m ) => 'attacker@example.com' === $m['recipient'] ) ), 'nothing sent for B' );
	}
);

test(
	'stores the quotation once, with the reserved number and exactly the reserved configuration',
	function () use ( $A ) {
		$q = reserve( $A, str_repeat( 'd', 64 ) )->get_data();
		same( 422, store_quote( $A, $q['id'], 'OF-20260101-ZZZZZZ', str_repeat( 'd', 64 ) )->get_status(), 'other number' );
		same( 422, store_quote( $A, $q['id'], $q['number'], str_repeat( 'e', 64 ) )->get_status(), 'other configuration' );
		same( 404, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/pdf", $A, '%PDF-1.7' )->get_status(), 'no PDF before the document' );
		same( 201, store_quote( $A, $q['id'], $q['number'], str_repeat( 'd', 64 ) )->get_status(), 'stored' );
		same( 409, store_quote( $A, $q['id'], $q['number'], str_repeat( 'd', 64 ) )->get_status(), 'never overwritten' );
		same( 422, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/pdf", $A, 'not a pdf' )->get_status(), 'PDF validated' );
		same( 201, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/pdf", $A, '%PDF-1.7 first' )->get_status(), 'PDF stored' );
		same( 200, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/pdf", $A, '%PDF-1.7 second' )->get_status(), 'PDF write-once' );
		same( '%PDF-1.7 first', file_get_contents( multi3d_quote_dir( $q['id'] ) . '/quote.pdf' ), 'first PDF kept' );
		same( 422, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/renderings/2", $A, "\x89PNG\r\n\x1a\nX" )->get_status(), 'only the declared renderings' );
		same( 201, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/renderings/1", $A, "\x89PNG\r\n\x1a\nX" )->get_status(), 'rendering stored' );
		$row = rows( 'quotes', "id = '{$q['id']}'" )[0];
		same( 'stored', $row['status'], 'status' );
		same( multi3d_utc_plus_days( 60, $row['created_at'] ), $row['expires_at'], '60-day retention' );
		same( $q['id'], get_post_meta( (int) $row['post_id'], '_multi3d_quote_id' ), 'record linked to the internal id' );
	}
);

test(
	'e-mails the stored PDF of the owner, reports failures and rate-limits',
	function () use ( $A ) {
		global $wpdb;
		$wpdb->query( 'DELETE FROM stub_mail' );
		$q = full_quote( $A );
		same( 422, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/email", $A, array( 'email' => "x@y.pl\r\nBcc: z@w.pl" ) )->get_status(), 'header injection rejected' );
		same( 200, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/email", $A, array( 'email' => 'klient@example.pl' ) )->get_status(), 'sent' );
		$mail = mails()[0];
		same( 'klient@example.pl', $mail['recipient'], 'recipient' );
		check( false !== strpos( $mail['subject'], $q['number'] ), 'number in the subject' );
		same( true, json_decode( $mail['attachments'], true )[0]['pdf'], 'the stored PDF is attached' );
		update_option( 'stub_mail_fail', true );
		same( 502, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/email", $A, array( 'email' => 'klient@example.pl' ) )->get_status(), 'delivery failure reported' );
		update_option( 'stub_mail_fail', false );
		for ( $i = 0; $i < 3; $i++ ) {
			call( 'POST', "/multi3d/v1/quotes/{$q['id']}/email", $A, array( 'email' => 'klient@example.pl' ) );
		}
		same( 429, call( 'POST', "/multi3d/v1/quotes/{$q['id']}/email", $A, array( 'email' => 'klient@example.pl' ) )->get_status(), 'rate-limited per address' );
	}
);

// ---------------------------------------------------------------- shared configurations

test(
	'shared snapshots are read-only by token hash; the answer contains the snapshot only',
	function () use ( $A, $B ) {
		$token = token();
		$made  = call( 'POST', '/multi3d/v1/shares', $A, share_payload( $token, 4321 ) );
		same( 201, $made->get_status(), 'created' );
		same( 401, call( 'POST', '/multi3d/v1/shares', '', share_payload( token() ) )->get_status(), 'creating needs a session' );
		same( 422, call( 'POST', '/multi3d/v1/shares', $A, array( 'token_hash' => hash( 'sha256', token() ), 'snapshot' => '{"format":"other"}', 'schema_version' => 1 ) )->get_status(), 'unknown format rejected' );
		$read = call( 'POST', '/multi3d/v1/shares/lookup', $B, array( 'token_hash' => hash( 'sha256', $token ) ) );
		same( 200, $read->get_status(), 'anyone with the link reads it' );
		same( array( 'snapshot', 'created_at', 'expires_at' ), array_keys( $read->get_data() ), 'no owner, quotation or e-mail data' );
		same( 4321, json_decode( $read->get_data()['snapshot'], true )['arrangement']['room']['width'], 'the stored snapshot' );
		same( 404, call( 'POST', '/multi3d/v1/shares/lookup', $B, array( 'token_hash' => hash( 'sha256', token() ) ) )->get_status(), 'unknown token' );
		same( 404, call( 'POST', '/multi3d/v1/shares/lookup', $B, array( 'token_hash' => 'nothex' ) )->get_status(), 'malformed hash' );
		$row = rows( 'shared_configs', "token_hash = '" . hash( 'sha256', $token ) . "'" )[0];
		same( multi3d_utc_plus_days( 60, $row['created_at'] ), $row['expires_at'], '60 days' );
		check( false === strpos( json_encode( $row ), $token ), 'the plaintext token is not stored' );
	}
);

test(
	'expired links are refused with 410',
	function () use ( $A ) {
		global $wpdb;
		$token = token();
		call( 'POST', '/multi3d/v1/shares', $A, share_payload( $token ) );
		$wpdb->update( multi3d_table( 'shared_configs' ), array( 'expires_at' => '2020-01-01 00:00:00' ), array( 'token_hash' => hash( 'sha256', $token ) ) );
		same( 410, call( 'POST', '/multi3d/v1/shares/lookup', $A, array( 'token_hash' => hash( 'sha256', $token ) ) )->get_status(), 'expired' );
	}
);

test(
	'e-mails an existing link of its creator only, without creating a snapshot or storing the address',
	function () use ( $A, $B ) {
		global $wpdb;
		$wpdb->query( 'DELETE FROM stub_mail' );
		$token = token();
		call( 'POST', '/multi3d/v1/shares', $A, share_payload( $token ) );
		$link  = "https://configurator.example.pl/c/{$token}";
		$count = count( rows( 'shared_configs' ) );
		$body  = array( 'token_hash' => hash( 'sha256', $token ), 'link' => $link, 'email' => 'odbiorca@example.pl', 'locale' => 'pl' );
		same( 404, call( 'POST', '/multi3d/v1/shares/email', $B, $body )->get_status(), 'another session cannot send it' );
		same( 422, call( 'POST', '/multi3d/v1/shares/email', $A, array_merge( $body, array( 'link' => 'https://evil.example/c/' . token() ) ) )->get_status(), 'the link must be this snapshot' );
		same( 200, call( 'POST', '/multi3d/v1/shares/email', $A, $body )->get_status(), 'sent' );
		same( 200, call( 'POST', '/multi3d/v1/shares/email', $A, $body )->get_status(), 'retry' );
		same( $count, count( rows( 'shared_configs' ) ), 'no new snapshot per e-mail' );
		$mail = mails()[0];
		check( false !== strpos( $mail['body'], $link ), 'link in the message' );
		check( false !== strpos( $mail['body'], '60 dni' ), '60-day availability in the message' );
		check( false === strpos( json_encode( rows( 'shared_configs' ) ), 'odbiorca@' ), 'the address is not stored' );
	}
);

test(
	'rate-limits sharing per address and per session',
	function () {
		$session = token();
		$codes   = array();
		for ( $i = 0; $i < 21; $i++ ) {
			$codes[] = call( 'POST', '/multi3d/v1/shares', $session, share_payload( token() ), array( 'ip' => '198.51.100.77' ) )->get_status();
		}
		same( 201, $codes[19], '20th accepted' );
		same( 429, $codes[20], '21st refused (per session)' );
	}
);

// ---------------------------------------------------------------- cart hand-off, orders, retention

test(
	'a single-use claim links the order to the quotation; the order keeps its snapshots',
	function () use ( $A ) {
		$q     = full_quote( $A );
		$claim = call( 'POST', "/multi3d/v1/quotes/{$q['id']}/cart-claim", $A )->get_data()['claim'];
		check( (bool) preg_match( MULTI3D_TOKEN_RE, $claim ), 'claim issued' );
		WC()->initialize_session();
		WC()->session->set_customer_session_cookie( true );
		do_action( 'multi3d_cart_request', array( 'quoteNumber' => $q['number'] ) );
		same( null, WC()->session->get( 'multi3d_quote_id' ), 'a quotation number is not accepted' );
		do_action( 'multi3d_cart_request', array( 'quoteClaim' => $claim ) );
		same( $q['id'], WC()->session->get( 'multi3d_quote_id' ), 'claim accepted' );
		same( null, multi3d_take_cart_claim( $claim ), 'claim is single-use' );
		WC()->session->set( MULTI3D_SESSION_KEY, '{"format":"multi3d-arrangement"}' );
		$order = new Stub_Order();
		do_action( 'woocommerce_checkout_create_order', $order );
		same( $q['id'], $order->get_meta( '_multi3d_quote_id' ), 'order linked by id' );
		same( $q['number'], $order->get_meta( '_multi3d_quote_number' ), 'order shows the number' );
		check( false !== strpos( $order->get_meta( '_multi3d_quote' ), '"total":100' ), 'pricing snapshot copied to the order' );
		same( '{"format":"multi3d-arrangement"}', $order->get_meta( '_multi3d_arrangement' ), 'configuration copied to the order' );
		$row = rows( 'quotes', "id = '{$q['id']}'" )[0];
		same( array( 'ordered', null ), array( $row['status'], $row['expires_at'] ), 'quotation kept' );
		$share = rows( 'shared_configs', "quote_id = '{$q['id']}'" )[0];
		same( array( 'ordered', null ), array( $share['status'], $share['expires_at'] ), 'its configuration link kept' );
	}
);

test(
	'the daily purge removes expired temporary data and keeps everything ordered',
	function () use ( $A ) {
		global $wpdb;
		$past     = '2020-01-01 00:00:00';
		$expired  = full_quote( $A );
		$ordered  = full_quote( $A );
		$abandon  = reserve( $A )->get_data();
		$token    = token();
		call( 'POST', '/multi3d/v1/shares', $A, share_payload( $token ) );
		$live_tok = token();
		call( 'POST', '/multi3d/v1/shares', $A, share_payload( $live_tok ) );
		$quotes = multi3d_table( 'quotes' );
		$wpdb->update( $quotes, array( 'expires_at' => $past ), array( 'id' => $expired['id'] ) );
		$wpdb->update( $quotes, array( 'status' => 'ordered', 'expires_at' => null, 'created_at' => $past ), array( 'id' => $ordered['id'] ) );
		$wpdb->update( multi3d_table( 'shared_configs' ), array( 'status' => 'ordered', 'expires_at' => null ), array( 'quote_id' => $ordered['id'] ) );
		$wpdb->update( $quotes, array( 'expires_at' => $past ), array( 'id' => $abandon['id'] ) );
		$wpdb->update( multi3d_table( 'shared_configs' ), array( 'expires_at' => $past ), array( 'token_hash' => hash( 'sha256', $token ) ) );
		$post_id = (int) rows( 'quotes', "id = '{$expired['id']}'" )[0]['post_id'];
		// An unreferenced file directory, two days old.
		$orphan = multi3d_ensure_quote_dir( multi3d_uuid4() );
		touch( $orphan, time() - 2 * DAY_IN_SECONDS );
		// A legacy quotation past its 60 days.
		$legacy = wp_insert_post( array( 'post_type' => 'multi3d_quote', 'post_status' => 'private', 'post_title' => 'OF-20250101-WXYZ' ) );
		update_post_meta( $legacy, '_multi3d_quote_status', 'temporary' );
		update_post_meta( $legacy, '_multi3d_quote_expires', time() - 10 );

		do_action( 'multi3d_purge_quotes' );

		same( 0, count( rows( 'quotes', "id = '{$expired['id']}'" ) ), 'expired quotation removed' );
		same( 0, count( rows( 'shared_configs', "quote_id = '{$expired['id']}'" ) ), 'with its configuration link' );
		same( '', get_post_type( $post_id ) ?? '', 'and its record' );
		check( ! file_exists( multi3d_quote_dir( $expired['id'] ) . '/quote.pdf' ), 'and its files' );
		same( 0, count( rows( 'quotes', "id = '{$abandon['id']}'" ) ), 'abandoned reservation removed' );
		same( 0, count( rows( 'shared_configs', "token_hash = '" . hash( 'sha256', $token ) . "'" ) ), 'expired shared link removed' );
		same( 1, count( rows( 'shared_configs', "token_hash = '" . hash( 'sha256', $live_tok ) . "'" ) ), 'live shared link kept' );
		same( 1, count( rows( 'quotes', "id = '{$ordered['id']}'" ) ), 'ordered quotation kept' );
		same( 1, count( rows( 'shared_configs', "quote_id = '{$ordered['id']}'" ) ), 'its link kept' );
		check( file_exists( multi3d_quote_dir( $ordered['id'] ) . '/quote.pdf' ), 'its PDF kept' );
		check( ! is_dir( $orphan ), 'orphaned directory removed' );
		same( '', get_post_type( $legacy ) ?? '', 'expired legacy quotation removed' );
	}
);

echo "\n{$passed} checks passed, {$failures} failed\n";
@unlink( $db );
exit( $failures > 0 ? 1 : 0 );
