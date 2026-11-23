<?php
/**
 * Plugin Name: Multi 3D Configurator – WooCommerce bridge
 * Description: Receives orders from the multi-furniture 3D configurator, adds every configured module to the WooCommerce cart (WooCommerce prices them) and stores the complete arrangement with the order so it can be reconstructed.
 * Version: 0.1.0
 * Requires Plugins: woocommerce
 * Text Domain: multi3d
 *
 * Flow:
 * 1. The configurator POSTs a form to https://shop/?multi3d-cart=1 with the field `multi3d_order`
 *    (JSON, format "multi3d-order", see src/domain/commerce/order.ts). It is a top-level navigation,
 *    so the cart is created in the customer's own shop session.
 * 2. For each ordered module the plugin adds its lines to the cart:
 *    - "product-options": a product configured through its product-options form (ThemeComplete Extra
 *      Product Options on clickbed.pl). The fields are placed in $_POST exactly as the product page
 *      would post them, so the options plugin validates and prices them as for a normal add-to-cart.
 *    - "sku": a simple product or variation looked up by SKU (cabinet component catalog).
 * 3. Each cart line keeps the module id, furniture type and note; the arrangement document is kept in
 *    the session and saved on the order (meta `_multi3d_arrangement`), with per-line meta.
 * 4. The customer is redirected to the cart. Prices always come from WooCommerce.
 *
 * Optional: define MULTI3D_ALLOWED_ORIGIN (e.g. 'https://configurator.example.com') in wp-config.php
 * to allow the configurator to read product prices from the public Store API cross-origin.
 */

defined( 'ABSPATH' ) || exit;

const MULTI3D_ORDER_FIELD   = 'multi3d_order';
const MULTI3D_MAX_BYTES     = 1048576;
const MULTI3D_SESSION_KEY   = 'multi3d_arrangement';
const MULTI3D_CART_ITEM_KEY = 'multi3d';

require_once __DIR__ . '/includes/quotes.php';
register_activation_hook( __FILE__, 'multi3d_schedule_quote_purge' );
register_deactivation_hook( __FILE__, 'multi3d_unschedule_quote_purge' );

add_action( 'wp_loaded', 'multi3d_handle_cart_request', 20 );

function multi3d_handle_cart_request() {
	if ( ! isset( $_GET['multi3d-cart'] ) || 'POST' !== ( $_SERVER['REQUEST_METHOD'] ?? '' ) || ! function_exists( 'WC' ) ) {
		return;
	}
	$raw = isset( $_POST[ MULTI3D_ORDER_FIELD ] ) ? wp_unslash( $_POST[ MULTI3D_ORDER_FIELD ] ) : ''; // phpcs:ignore WordPress.Security.NonceVerification, WordPress.Security.ValidatedSanitizedInput
	if ( ! is_string( $raw ) || '' === $raw || strlen( $raw ) > MULTI3D_MAX_BYTES ) {
		multi3d_fail( __( 'The configuration could not be read.', 'multi3d' ) );
	}
	$order = json_decode( $raw, true );
	if ( ! is_array( $order ) || ( $order['format'] ?? '' ) !== 'multi3d-order' || 1 !== ( $order['schemaVersion'] ?? null ) || ! is_array( $order['modules'] ?? null ) ) {
		multi3d_fail( __( 'Unsupported configuration format.', 'multi3d' ) );
	}

	if ( null === WC()->session ) {
		WC()->initialize_session();
	}
	if ( ! WC()->session->has_session() ) {
		WC()->session->set_customer_session_cookie( true );
	}
	if ( null === WC()->cart ) {
		wc_load_cart();
	}

	// Lets the quotation module link the order to a stored quotation (includes/quotes.php).
	do_action( 'multi3d_cart_request', $order );

	$accepted = is_array( $order['acceptedTerms'] ?? null ) ? $order['acceptedTerms'] : array();
	$added    = 0;
	foreach ( $order['modules'] as $module ) {
		if ( ! is_array( $module ) || ! is_array( $module['items'] ?? null ) ) {
			continue;
		}
		$context = array(
			'module_id' => sanitize_text_field( (string) ( $module['moduleId'] ?? '' ) ),
			'type'      => sanitize_key( (string) ( $module['typeId'] ?? '' ) ),
		);
		foreach ( $module['items'] as $item ) {
			if ( multi3d_add_item( $item, $context, $accepted ) ) {
				++$added;
			}
		}
	}

	// Keep the full arrangement for the order (also when only some modules were ordered).
	if ( is_array( $order['arrangement'] ?? null ) ) {
		WC()->session->set( MULTI3D_SESSION_KEY, wp_json_encode( $order['arrangement'] ) );
	}

	if ( $added > 0 ) {
		wc_add_notice( __( 'Your configuration has been added to the cart.', 'multi3d' ), 'success' );
	}
	wp_safe_redirect( wc_get_cart_url() );
	exit;
}

function multi3d_fail( $message ) {
	if ( function_exists( 'wc_add_notice' ) ) {
		wc_add_notice( $message, 'error' );
	}
	wp_safe_redirect( function_exists( 'wc_get_cart_url' ) ? wc_get_cart_url() : home_url( '/' ) );
	exit;
}

/**
 * Adds one line. Returns true when WooCommerce accepted it; WooCommerce (and the options plugin)
 * report their own notices otherwise.
 */
function multi3d_add_item( $item, array $context, array $accepted ) {
	if ( ! is_array( $item ) ) {
		return false;
	}
	$quantity = max( 1, (int) ( $item['quantity'] ?? 1 ) );
	$kind     = $item['kind'] ?? '';

	if ( 'product-options' === $kind ) {
		$product_id = absint( $item['productId'] ?? 0 );
		$product    = wc_get_product( $product_id );
		if ( ! $product || ! $product->is_purchasable() || ! is_array( $item['fields'] ?? null ) ) {
			wc_add_notice( sprintf( __( 'Product #%d is not available.', 'multi3d' ), $product_id ), 'error' );
			return false;
		}
		$fields = array();
		foreach ( $item['fields'] as $name => $value ) {
			// Only the options plugin's own form fields are forwarded.
			if ( is_string( $name ) && preg_match( '/^tmcp_[a-z]+_\d+(_\d+)?$/', $name ) && is_string( $value ) ) {
				$fields[ $name ] = $value;
			}
		}
		// The shop's terms checkbox: only if the customer ticked it in the configurator.
		$terms_field = is_string( $item['termsField'] ?? null ) ? $item['termsField'] : '';
		$terms_key   = $product_id . ':' . $terms_field;
		if ( $terms_field && preg_match( '/^tmcp_checkbox_\d+_\d+$/', $terms_field ) && isset( $accepted[ $terms_key ] ) && $accepted[ $terms_key ] === ( $item['termsValue'] ?? null ) ) {
			$fields[ $terms_field ] = (string) $item['termsValue'];
		}
		$request = array_merge(
			$fields,
			array(
				'add-to-cart' => $product_id,
				'tcaddtocart' => $product_id,
				'quantity'    => $quantity,
			)
		);
		$backup_post    = $_POST; // phpcs:ignore WordPress.Security.NonceVerification
		$backup_request = $_REQUEST; // phpcs:ignore WordPress.Security.NonceVerification
		$_POST          = $request;
		$_REQUEST       = $request;
		$key            = WC()->cart->add_to_cart( $product_id, $quantity, 0, array(), array( MULTI3D_CART_ITEM_KEY => $context ) );
		$_POST          = $backup_post;
		$_REQUEST       = $backup_request;
		return (bool) $key;
	}

	if ( 'sku' === $kind ) {
		$sku        = sanitize_text_field( (string) ( $item['sku'] ?? '' ) );
		$product_id = $sku ? wc_get_product_id_by_sku( $sku ) : 0;
		$product    = $product_id ? wc_get_product( $product_id ) : null;
		if ( ! $product || ! $product->is_purchasable() ) {
			wc_add_notice( sprintf( __( 'Product %s is not available in the shop.', 'multi3d' ), esc_html( $sku ) ), 'error' );
			return false;
		}
		$data = array( MULTI3D_CART_ITEM_KEY => array_merge( $context, array( 'note' => sanitize_text_field( (string) ( $item['note'] ?? '' ) ) ) ) );
		if ( $product->is_type( 'variation' ) ) {
			return (bool) WC()->cart->add_to_cart( $product->get_parent_id(), $quantity, $product->get_id(), $product->get_variation_attributes(), $data );
		}
		return (bool) WC()->cart->add_to_cart( $product->get_id(), $quantity, 0, array(), $data );
	}
	return false;
}

/** Shows which configured module a cart line belongs to. */
add_filter(
	'woocommerce_get_item_data',
	function ( $data, $cart_item ) {
		$meta = $cart_item[ MULTI3D_CART_ITEM_KEY ] ?? null;
		if ( is_array( $meta ) && ! empty( $meta['module_id'] ) ) {
			$data[] = array(
				'name'  => __( 'Configured module', 'multi3d' ),
				'value' => esc_html( $meta['module_id'] . ( $meta['type'] ? ' (' . $meta['type'] . ')' : '' ) ),
			);
			if ( ! empty( $meta['note'] ) ) {
				$data[] = array( 'name' => __( 'For', 'multi3d' ), 'value' => esc_html( $meta['note'] ) );
			}
		}
		return $data;
	},
	10,
	2
);

/** Line meta on the order: module id, furniture type, note. */
add_action(
	'woocommerce_checkout_create_order_line_item',
	function ( $line, $cart_item_key, $values ) {
		$meta = $values[ MULTI3D_CART_ITEM_KEY ] ?? null;
		if ( ! is_array( $meta ) ) {
			return;
		}
		$line->add_meta_data( '_multi3d_module_id', $meta['module_id'] ?? '' );
		$line->add_meta_data( '_multi3d_type', $meta['type'] ?? '' );
		if ( ! empty( $meta['note'] ) ) {
			$line->add_meta_data( __( 'For', 'multi3d' ), $meta['note'] );
		}
	},
	10,
	3
);

/** The complete arrangement document on the order, for reconstruction. */
add_action(
	'woocommerce_checkout_create_order',
	function ( $order ) {
		$arrangement = WC()->session ? WC()->session->get( MULTI3D_SESSION_KEY ) : null;
		if ( is_string( $arrangement ) && '' !== $arrangement ) {
			$order->update_meta_data( '_multi3d_arrangement', $arrangement );
			WC()->session->set( MULTI3D_SESSION_KEY, null );
		}
	}
);

/** Read-only view of the stored arrangement in the order admin (classic and HPOS screens). */
add_action(
	'add_meta_boxes',
	function () {
		foreach ( array( 'shop_order', 'woocommerce_page_wc-orders' ) as $screen ) {
			add_meta_box(
				'multi3d-arrangement',
				__( 'Configurator arrangement', 'multi3d' ),
				function ( $post_or_order ) {
					$order = $post_or_order instanceof WC_Order ? $post_or_order : wc_get_order( $post_or_order->ID );
					$json  = $order ? $order->get_meta( '_multi3d_arrangement' ) : '';
					if ( ! $json ) {
						echo '<p>' . esc_html__( 'No configurator data.', 'multi3d' ) . '</p>';
						return;
					}
					$pretty = wp_json_encode( json_decode( $json ), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
					echo '<p>' . esc_html__( 'Import this JSON in the configurator (Arrangement → Import) to reconstruct the order.', 'multi3d' ) . '</p>';
					echo '<textarea readonly rows="12" style="width:100%;font-family:monospace">' . esc_textarea( $pretty ) . '</textarea>';
				},
				$screen,
				'normal'
			);
		}
	}
);

/** Optional CORS for read-only Store API requests from the configurator's origin. */
add_action(
	'rest_api_init',
	function () {
		if ( ! defined( 'MULTI3D_ALLOWED_ORIGIN' ) ) {
			return;
		}
		add_filter(
			'rest_pre_serve_request',
			function ( $served, $result, $request ) {
				if ( 'GET' === $request->get_method() && 0 === strpos( $request->get_route(), '/wc/store/' ) ) {
					header( 'Access-Control-Allow-Origin: ' . esc_url_raw( MULTI3D_ALLOWED_ORIGIN ) );
					header( 'Vary: Origin', false );
				}
				return $served;
			},
			10,
			3
		);
	}
);
