<?php
/**
 * HTTP front controller for end-to-end tests: `php -S 127.0.0.1:8790 test/php/server.php`.
 * Serves the real multi3d-configurator plugin on the WordPress stub (SQLite):
 *
 * - /?rest_route=/multi3d/v1/…        the plugin's REST API (signed BFF calls)
 * - /wp-json/wc/store/v1/products     WooCommerce Store API stand-in (public prices, CORS)
 * - POST /?multi3d-cart=1             the plugin's cart hand-off (customer's own shop session cookie)
 * - /?harness=…                       test inspection: cart, checkout, mail, shares, purge, stock
 *
 * TEST CODE ONLY — never deployed. Bind it to 127.0.0.1.
 */

require __DIR__ . '/wp-stub.php';
stub_boot_plugin();

function harness_json( $data, $status = 200 ) {
	http_response_code( $status );
	header( 'Content-Type: application/json' );
	header( 'Access-Control-Allow-Origin: *' );
	echo json_encode( $data );
	exit;
}

$path = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );

// ---------------------------------------------------------------- REST API
if ( isset( $_GET['rest_route'] ) ) {
	$request = new WP_REST_Request( $_SERVER['REQUEST_METHOD'], (string) $_GET['rest_route'], getallheaders(), (string) file_get_contents( 'php://input' ) );
	$result  = stub_rest_dispatch( $request );
	if ( apply_filters( 'rest_pre_serve_request', false, $result, $request, null ) ) {
		exit;
	}
	http_response_code( $result->get_status() );
	header( 'Content-Type: application/json; charset=UTF-8' );
	foreach ( $result->headers as $name => $value ) {
		header( "{$name}: {$value}" );
	}
	echo json_encode( $result->get_data() );
	exit;
}

// ---------------------------------------------------------------- Store API (public catalog)
if ( '/wp-json/wc/store/v1/products' === $path ) {
	$catalog = stub_catalog();
	$include = array_filter( array_map( 'intval', explode( ',', (string) ( $_GET['include'] ?? '' ) ) ) );
	$out     = array();
	foreach ( $include as $id ) {
		if ( isset( $catalog['ids'][ $id ] ) ) {
			$p     = $catalog['ids'][ $id ];
			$out[] = array(
				'id'          => $id,
				'name'        => $p['name'],
				'sku'         => '',
				'permalink'   => "http://shop.test/?p={$id}",
				'is_in_stock' => $p['in_stock'],
				'prices'      => array( 'price' => (string) $p['price'], 'currency_code' => 'PLN', 'currency_minor_unit' => 2, 'currency_prefix' => '', 'currency_suffix' => ' zł' ),
			);
		}
	}
	harness_json( $out );
}

// ---------------------------------------------------------------- cart hand-off (top-level form post)
if ( isset( $_GET['multi3d-cart'] ) ) {
	do_action( 'wp_loaded' );
	exit;
}

// ---------------------------------------------------------------- test inspection
global $wpdb;
switch ( $_GET['harness'] ?? '' ) {
	case 'cart':
		WC()->initialize_session();
		harness_json(
			array(
				'session'  => WC()->session->id,
				'lines'    => array_map( fn( $l ) => array( 'product_id' => $l['product_id'], 'module_id' => $l['data']['multi3d']['module_id'] ?? null ), (array) WC()->session->get( 'cart' ) ),
				'quote_id' => WC()->session->get( 'multi3d_quote_id' ),
				'notices'  => WC()->session->get( 'notices' ),
				'has_arrangement' => is_string( WC()->session->get( MULTI3D_SESSION_KEY ) ),
			)
		);
		break;
	case 'checkout':
		WC()->initialize_session();
		$order = new Stub_Order();
		do_action( 'woocommerce_checkout_create_order', $order );
		$wpdb->insert( 'stub_orders', array( 'meta' => json_encode( $order->meta ), 'lines' => json_encode( WC()->session->get( 'cart' ) ) ) );
		harness_json( array( 'order_id' => (int) $wpdb->pdo->lastInsertId(), 'meta_keys' => array_keys( $order->meta ), 'quote_number' => $order->get_meta( '_multi3d_quote_number' ) ) );
		break;
	case 'mail':
		harness_json( $wpdb->get_results( 'SELECT recipient, subject, body, attachments FROM stub_mail ORDER BY id' ) );
		break;
	case 'shares':
		harness_json( $wpdb->get_results( 'SELECT id, token_hash, snapshot, owner_hash, quote_id, status, created_at, expires_at FROM wp_multi3d_shared_configs ORDER BY created_at' ) );
		break;
	case 'quotes':
		harness_json( $wpdb->get_results( 'SELECT id, number, owner_hash, status, has_pdf, created_at, expires_at FROM wp_multi3d_quotes ORDER BY created_at' ) );
		break;
	case 'expire-share':
		$wpdb->update( 'wp_multi3d_shared_configs', array( 'expires_at' => '2020-01-01 00:00:00' ), array( 'token_hash' => (string) $_GET['hash'] ) );
		harness_json( array( 'ok' => true ) );
		break;
	case 'expire-quote':
		$wpdb->update( 'wp_multi3d_quotes', array( 'expires_at' => '2020-01-01 00:00:00' ), array( 'id' => (string) $_GET['id'] ) );
		harness_json( array( 'ok' => true ) );
		break;
	case 'purge':
		do_action( 'multi3d_purge_quotes' );
		harness_json( array( 'ok' => true ) );
		break;
	case 'stock':
		$catalog = stub_catalog();
		$catalog['ids'][ (int) $_GET['id'] ]['in_stock'] = '1' === ( $_GET['in'] ?? '1' );
		update_option( 'stub_catalog', $catalog );
		harness_json( array( 'ok' => true ) );
		break;
	case 'reset-limits':
		$wpdb->query( "DELETE FROM wp_options WHERE option_name LIKE '_transient_multi3d_rl_%'" );
		harness_json( array( 'ok' => true ) );
		break;
}
http_response_code( 404 );
echo 'not found';
