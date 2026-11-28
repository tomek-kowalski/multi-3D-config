<?php
/**
 * Minimal WordPress + WooCommerce stand-in for testing the multi3d-configurator plugin without a
 * WordPress installation. Storage is SQLite (MULTI3D_TEST_DB); the plugin's MySQL DDL is translated by
 * dbDelta() below, and its queries use only portable SQL. Duplicate-key errors are reported in MySQL's
 * wording ("Duplicate entry …"), as the plugin's collision handling expects.
 *
 * TEST CODE ONLY — never deployed.
 */

define( 'ABSPATH', __DIR__ . '/fake-wp/' );
define( 'ARRAY_A', 'ARRAY_A' );
define( 'HOUR_IN_SECONDS', 3600 );
define( 'DAY_IN_SECONDS', 86400 );
if ( ! defined( 'MULTI3D_BFF_SECRET' ) ) {
	define( 'MULTI3D_BFF_SECRET', getenv( 'MULTI3D_BFF_SECRET' ) ?: 'test-secret-test-secret-test-secret-0001' );
}

// ---------------------------------------------------------------- database

class Stub_WPDB {
	public $prefix     = 'wp_';
	public $last_error = '';
	public $pdo;
	private $suppress  = false;

	public function __construct( $file ) {
		$this->pdo = new PDO( 'sqlite:' . $file, null, null, array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION ) );
		$this->pdo->exec( 'PRAGMA busy_timeout = 5000' );
		$this->pdo->exec( 'CREATE TABLE IF NOT EXISTS wp_options (option_name TEXT PRIMARY KEY, option_value TEXT, expires INTEGER)' );
		$this->pdo->exec( 'CREATE TABLE IF NOT EXISTS wp_posts (ID INTEGER PRIMARY KEY AUTOINCREMENT, post_type TEXT, post_status TEXT, post_title TEXT)' );
		$this->pdo->exec( 'CREATE TABLE IF NOT EXISTS wp_postmeta (post_id INTEGER, meta_key TEXT, meta_value TEXT)' );
		$this->pdo->exec( 'CREATE TABLE IF NOT EXISTS stub_mail (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT, subject TEXT, body TEXT, attachments TEXT)' );
		$this->pdo->exec( 'CREATE TABLE IF NOT EXISTS stub_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, meta TEXT, lines TEXT)' );
	}

	public function get_charset_collate() {
		return '';
	}

	public function suppress_errors( $suppress = true ) {
		$previous       = $this->suppress;
		$this->suppress = $suppress;
		return $previous;
	}

	public function prepare( $sql, ...$args ) {
		if ( 1 === count( $args ) && is_array( $args[0] ) ) {
			$args = $args[0];
		}
		$pdo = $this->pdo;
		$i   = 0;
		return preg_replace_callback(
			'/%[sd]/',
			function ( $m ) use ( &$i, $args, $pdo ) {
				$value = $args[ $i++ ] ?? null;
				return '%d' === $m[0] ? (string) (int) $value : $pdo->quote( (string) $value );
			},
			$sql
		);
	}

	private function run( $sql, array $params = array() ) {
		$this->last_error = '';
		try {
			$statement = $this->pdo->prepare( $sql );
			$statement->execute( $params );
			return $statement;
		} catch ( PDOException $e ) {
			$message          = $e->getMessage();
			$this->last_error = false !== stripos( $message, 'UNIQUE constraint failed' ) ? "Duplicate entry for key: {$message}" : $message;
			return false;
		}
	}

	public function insert( $table, array $data ) {
		$columns = array_keys( $data );
		$sql     = sprintf( 'INSERT INTO %s (%s) VALUES (%s)', $table, implode( ',', $columns ), implode( ',', array_fill( 0, count( $columns ), '?' ) ) );
		$result  = $this->run( $sql, array_values( $data ) );
		return false === $result ? false : 1;
	}

	public function update( $table, array $data, array $where ) {
		$set    = implode( ',', array_map( fn( $c ) => "{$c} = ?", array_keys( $data ) ) );
		$cond   = implode( ' AND ', array_map( fn( $c ) => "{$c} = ?", array_keys( $where ) ) );
		$result = $this->run( "UPDATE {$table} SET {$set} WHERE {$cond}", array_merge( array_values( $data ), array_values( $where ) ) );
		return false === $result ? false : $result->rowCount();
	}

	public function delete( $table, array $where ) {
		$cond   = implode( ' AND ', array_map( fn( $c ) => "{$c} = ?", array_keys( $where ) ) );
		$result = $this->run( "DELETE FROM {$table} WHERE {$cond}", array_values( $where ) );
		return false === $result ? false : $result->rowCount();
	}

	public function query( $sql ) {
		$sql = trim( $sql );
		if ( 'START TRANSACTION' === strtoupper( $sql ) ) {
			$sql = 'BEGIN IMMEDIATE';
		}
		$result = $this->run( $sql );
		return false === $result ? false : $result->rowCount();
	}

	public function get_row( $sql, $output = ARRAY_A ) {
		$result = $this->run( $sql );
		$row    = $result ? $result->fetch( PDO::FETCH_ASSOC ) : false;
		return $row ? $row : null;
	}

	public function get_results( $sql, $output = ARRAY_A ) {
		$result = $this->run( $sql );
		return $result ? $result->fetchAll( PDO::FETCH_ASSOC ) : array();
	}

	public function get_var( $sql ) {
		$result = $this->run( $sql );
		$value  = $result ? $result->fetchColumn() : false;
		return false === $value ? null : $value;
	}
}

$GLOBALS['wpdb'] = new Stub_WPDB( getenv( 'MULTI3D_TEST_DB' ) ?: ':memory:' );

/** Translates the plugin's MySQL CREATE TABLE into SQLite (types, keys, indexes). */
function dbDelta( $sql ) {
	global $wpdb;
	if ( ! preg_match( '/CREATE TABLE (\w+) \((.*)\)[^)]*$/s', $sql, $m ) ) {
		throw new RuntimeException( 'dbDelta stub: unsupported SQL' );
	}
	$table   = $m[1];
	$columns = array();
	$indexes = array();
	foreach ( preg_split( '/,\n/', trim( $m[2] ) ) as $line ) {
		$line = trim( $line );
		if ( preg_match( '/^PRIMARY KEY\s+\((\w+)\)$/', $line, $k ) ) {
			$columns[] = "PRIMARY KEY ({$k[1]})";
		} elseif ( preg_match( '/^UNIQUE KEY (\w+) \(([\w,]+)\)$/', $line, $k ) ) {
			$columns[] = "UNIQUE ({$k[2]})";
		} elseif ( preg_match( '/^KEY (\w+) \(([\w,]+)\)$/', $line, $k ) ) {
			$indexes[] = "CREATE INDEX IF NOT EXISTS {$table}_{$k[1]} ON {$table} ({$k[2]})";
		} elseif ( preg_match( '/^(\w+) (\w+)/', $line, $c ) ) {
			$type      = preg_match( '/int/i', $c[2] ) ? 'INTEGER' : 'TEXT';
			$null      = false !== stripos( $line, 'NOT NULL' ) ? ' NOT NULL' : '';
			$default   = preg_match( '/DEFAULT (\S+)/', $line, $d ) && 'NULL' !== $d[1] ? " DEFAULT {$d[1]}" : '';
			$columns[] = "{$c[1]} {$type}{$null}{$default}";
		}
	}
	$wpdb->pdo->exec( "CREATE TABLE IF NOT EXISTS {$table} (" . implode( ', ', $columns ) . ')' );
	foreach ( $indexes as $index ) {
		$wpdb->pdo->exec( $index );
	}
}

// ---------------------------------------------------------------- hooks

$GLOBALS['stub_hooks'] = array();

function add_filter( $hook, $callback, $priority = 10, $args = 1 ) {
	$GLOBALS['stub_hooks'][ $hook ][ $priority ][] = array( $callback, $args );
}

function add_action( $hook, $callback, $priority = 10, $args = 1 ) {
	add_filter( $hook, $callback, $priority, $args );
}

function apply_filters( $hook, $value, ...$rest ) {
	$hooks = $GLOBALS['stub_hooks'][ $hook ] ?? array();
	ksort( $hooks );
	foreach ( $hooks as $callbacks ) {
		foreach ( $callbacks as list( $callback, $count ) ) {
			$value = call_user_func_array( $callback, array_slice( array_merge( array( $value ), $rest ), 0, $count ) );
		}
	}
	return $value;
}

function do_action( $hook, ...$args ) {
	$hooks = $GLOBALS['stub_hooks'][ $hook ] ?? array();
	ksort( $hooks );
	foreach ( $hooks as $callbacks ) {
		foreach ( $callbacks as list( $callback, $count ) ) {
			call_user_func_array( $callback, array_slice( $args, 0, $count ) );
		}
	}
}

function remove_all_filters( $hook ) {
	unset( $GLOBALS['stub_hooks'][ $hook ] );
}

function register_activation_hook( $file, $callback ) {
	$GLOBALS['stub_activation'][] = $callback;
}

function register_deactivation_hook( $file, $callback ) {}
function register_post_type( $type, $args ) {}
function add_meta_box( ...$args ) {}
function wp_next_scheduled( $hook ) {
	return false;
}
function wp_schedule_event( ...$args ) {}
function wp_clear_scheduled_hook( $hook ) {}

// ---------------------------------------------------------------- options and transients

function get_option( $name, $default = false ) {
	global $wpdb;
	$value = $wpdb->get_var( $wpdb->prepare( 'SELECT option_value FROM wp_options WHERE option_name = %s', $name ) );
	return null === $value ? $default : unserialize( $value );
}

function update_option( $name, $value, $autoload = null ) {
	global $wpdb;
	$wpdb->pdo->prepare( 'REPLACE INTO wp_options (option_name, option_value, expires) VALUES (?, ?, NULL)' )->execute( array( $name, serialize( $value ) ) );
	return true;
}

function get_transient( $name ) {
	global $wpdb;
	$row = $wpdb->get_row( $wpdb->prepare( 'SELECT option_value, expires FROM wp_options WHERE option_name = %s', '_transient_' . $name ) );
	if ( ! $row || ( $row['expires'] && (int) $row['expires'] < time() ) ) {
		return false;
	}
	return unserialize( $row['option_value'] );
}

function set_transient( $name, $value, $expiration = 0 ) {
	global $wpdb;
	$wpdb->pdo->prepare( 'REPLACE INTO wp_options (option_name, option_value, expires) VALUES (?, ?, ?)' )->execute( array( '_transient_' . $name, serialize( $value ), $expiration ? time() + $expiration : null ) );
	return true;
}

function delete_transient( $name ) {
	global $wpdb;
	$wpdb->pdo->prepare( 'DELETE FROM wp_options WHERE option_name = ?' )->execute( array( '_transient_' . $name ) );
	return true;
}

// ---------------------------------------------------------------- posts

function wp_insert_post( $post, $wp_error = false ) {
	global $wpdb;
	$wpdb->insert( 'wp_posts', array( 'post_type' => $post['post_type'], 'post_status' => $post['post_status'], 'post_title' => $post['post_title'] ) );
	return (int) $wpdb->pdo->lastInsertId();
}

function update_post_meta( $post_id, $key, $value ) {
	global $wpdb;
	$wpdb->delete( 'wp_postmeta', array( 'post_id' => $post_id, 'meta_key' => $key ) );
	$wpdb->insert( 'wp_postmeta', array( 'post_id' => $post_id, 'meta_key' => $key, 'meta_value' => is_string( $value ) ? wp_unslash( $value ) : serialize( $value ) ) );
	return true;
}

function delete_post_meta( $post_id, $key ) {
	global $wpdb;
	$wpdb->delete( 'wp_postmeta', array( 'post_id' => $post_id, 'meta_key' => $key ) );
}

function get_post_meta( $post_id, $key, $single = true ) {
	global $wpdb;
	$value = $wpdb->get_var( $wpdb->prepare( 'SELECT meta_value FROM wp_postmeta WHERE post_id = %d AND meta_key = %s', $post_id, $key ) );
	return null === $value ? '' : $value;
}

function get_post_type( $post_id ) {
	global $wpdb;
	return $wpdb->get_var( $wpdb->prepare( 'SELECT post_type FROM wp_posts WHERE ID = %d', $post_id ) );
}

function get_the_title( $post_id ) {
	global $wpdb;
	return (string) $wpdb->get_var( $wpdb->prepare( 'SELECT post_title FROM wp_posts WHERE ID = %d', $post_id ) );
}

function wp_delete_post( $post_id, $force = false ) {
	global $wpdb;
	do_action( 'before_delete_post', $post_id );
	$wpdb->delete( 'wp_postmeta', array( 'post_id' => $post_id ) );
	$wpdb->delete( 'wp_posts', array( 'ID' => $post_id ) );
	return true;
}

/** get_posts(): only the argument shapes the plugin uses (title, or the legacy status/expiry meta query). */
function get_posts( $args ) {
	global $wpdb;
	$ids = $wpdb->get_results( $wpdb->prepare( 'SELECT ID, post_title FROM wp_posts WHERE post_type = %s', $args['post_type'] ) );
	$out = array();
	foreach ( $ids as $row ) {
		$id = (int) $row['ID'];
		if ( isset( $args['title'] ) && $row['post_title'] !== $args['title'] ) {
			continue;
		}
		if ( isset( $args['meta_query'] ) ) {
			if ( get_post_meta( $id, '_multi3d_quote_status' ) !== 'temporary' ) {
				continue;
			}
			$expires = get_post_meta( $id, '_multi3d_quote_expires' );
			if ( '' === $expires || (int) $expires >= (int) $args['meta_query'][1]['value'] ) {
				continue;
			}
		}
		$out[] = $id;
	}
	return array_slice( $out, 0, $args['posts_per_page'] ?? 10 );
}

// ---------------------------------------------------------------- misc WordPress

function __( $text, $domain = null ) {
	return $text;
}
function esc_html__( $text, $domain = null ) {
	return $text;
}
function esc_html( $text ) {
	return htmlspecialchars( (string) $text, ENT_QUOTES );
}
function esc_textarea( $text ) {
	return esc_html( $text );
}
function esc_url_raw( $url ) {
	return (string) $url;
}
function sanitize_text_field( $text ) {
	return trim( preg_replace( '/[\r\n\t]+/', ' ', strip_tags( (string) $text ) ) );
}
function sanitize_key( $key ) {
	return preg_replace( '/[^a-z0-9_\-]/', '', strtolower( (string) $key ) );
}
function sanitize_email( $email ) {
	$email = trim( (string) $email );
	return preg_match( '/[\r\n,;<>]/', $email ) ? '' : $email;
}
function is_email( $email ) {
	return false !== filter_var( $email, FILTER_VALIDATE_EMAIL );
}
function absint( $value ) {
	return abs( (int) $value );
}
function wp_json_encode( $data, $flags = 0 ) {
	return json_encode( $data, $flags );
}
function wp_slash( $value ) {
	return is_string( $value ) ? addslashes( $value ) : $value;
}
function wp_unslash( $value ) {
	return is_string( $value ) ? stripslashes( $value ) : $value;
}
function wp_specialchars_decode( $text, $quotes = 0 ) {
	return htmlspecialchars_decode( (string) $text, ENT_QUOTES );
}
function get_bloginfo( $what ) {
	return 'Sklep testowy';
}
function home_url( $path = '' ) {
	return 'http://shop.test' . $path;
}
function trailingslashit( $path ) {
	return rtrim( $path, '/\\' ) . '/';
}
function wp_upload_dir() {
	return array( 'basedir' => getenv( 'MULTI3D_TEST_UPLOADS' ) ?: sys_get_temp_dir() . '/multi3d-uploads' );
}
function wp_mkdir_p( $dir ) {
	return is_dir( $dir ) || mkdir( $dir, 0777, true );
}
function wp_delete_file( $file ) {
	@unlink( $file );
}
function is_wp_error( $thing ) {
	return $thing instanceof WP_Error;
}
function wp_generate_uuid4() {
	throw new LogicException( 'wp_generate_uuid4 uses mt_rand: the plugin must use multi3d_uuid4()' );
}

/** wp_mail(): recorded in the stub_mail table (MULTI3D_TEST_MAIL_FAIL=1 simulates a failure). */
function wp_mail( $to, $subject, $message, $headers = '', $attachments = array() ) {
	global $wpdb;
	if ( get_option( 'stub_mail_fail' ) ) {
		return false;
	}
	$wpdb->insert(
		'stub_mail',
		array(
			'recipient'   => $to,
			'subject'     => $subject,
			'body'        => $message,
			'attachments' => json_encode( array_map( fn( $f ) => array( 'name' => basename( $f ), 'size' => filesize( $f ), 'pdf' => 0 === strpos( (string) file_get_contents( $f ), '%PDF-' ) ), (array) $attachments ) ),
		)
	);
	return true;
}

class WP_Error {
	public $code;
	public $message;
	public $data;
	public function __construct( $code = '', $message = '', $data = null ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}
}

class WP_REST_Response {
	public $data;
	public $status;
	public $headers = array();
	public function __construct( $data = null, $status = 200 ) {
		$this->data   = $data;
		$this->status = $status;
	}
	public function header( $name, $value ) {
		$this->headers[ $name ] = $value;
	}
	public function get_data() {
		return $this->data;
	}
	public function get_status() {
		return $this->status;
	}
}

class WP_REST_Request implements ArrayAccess {
	private $method;
	private $route;
	private $headers;
	private $body;
	private $params = array();
	public function __construct( $method, $route, array $headers = array(), $body = '' ) {
		$this->method = strtoupper( $method );
		$this->route  = $route;
		$this->body   = (string) $body;
		$this->headers = array();
		foreach ( $headers as $name => $value ) {
			$this->headers[ str_replace( '-', '_', strtolower( $name ) ) ] = $value;
		}
	}
	public function get_method() {
		return $this->method;
	}
	public function get_route() {
		return $this->route;
	}
	public function get_header( $name ) {
		return $this->headers[ str_replace( '-', '_', strtolower( $name ) ) ] ?? null;
	}
	public function get_body() {
		return $this->body;
	}
	public function get_json_params() {
		$data = json_decode( $this->body, true );
		return is_array( $data ) ? $data : null;
	}
	public function set_url_params( array $params ) {
		$this->params = $params;
	}
	public function offsetExists( $key ): bool {
		return isset( $this->params[ $key ] );
	}
	public function offsetGet( $key ): mixed {
		return $this->params[ $key ] ?? null;
	}
	public function offsetSet( $key, $value ): void {
		$this->params[ $key ] = $value;
	}
	public function offsetUnset( $key ): void {
		unset( $this->params[ $key ] );
	}
}

$GLOBALS['stub_routes'] = array();

function register_rest_route( $namespace, $route, $args ) {
	$GLOBALS['stub_routes'][] = array( '/' . $namespace . $route, $args );
}

/** Dispatches like the REST server: route match, method, permission_callback, callback. */
function stub_rest_dispatch( WP_REST_Request $request ) {
	$matched_route = false;
	foreach ( $GLOBALS['stub_routes'] as list( $pattern, $args ) ) {
		if ( ! preg_match( '#^' . $pattern . '$#', $request->get_route(), $m ) ) {
			continue;
		}
		$matched_route = true;
		if ( ! in_array( $request->get_method(), array_map( 'trim', explode( ',', $args['methods'] ) ), true ) ) {
			continue;
		}
		$request->set_url_params( array_filter( $m, 'is_string', ARRAY_FILTER_USE_KEY ) );
		$permission = call_user_func( $args['permission_callback'], $request );
		if ( true !== $permission ) {
			$status = is_wp_error( $permission ) ? ( $permission->data['status'] ?? 403 ) : 403;
			return new WP_REST_Response( array( 'code' => is_wp_error( $permission ) ? $permission->code : 'rest_forbidden' ), $status );
		}
		return call_user_func( $args['callback'], $request );
	}
	return new WP_REST_Response( array( 'code' => $matched_route ? 'rest_no_route_method' : 'rest_no_route' ), $matched_route ? 405 : 404 );
}

// ---------------------------------------------------------------- WooCommerce (cart session and catalog)

/** Customer session keyed by the `stub_wc_session` cookie, stored as an option. */
class Stub_WC_Session {
	public $id   = null;
	public $data = array();
	public function __construct() {
		$cookie = $_COOKIE['stub_wc_session'] ?? '';
		if ( preg_match( '/^[a-f0-9]{32}$/', $cookie ) ) {
			$this->id   = $cookie;
			$this->data = get_option( 'stub_wc_session_' . $cookie, array() );
		}
	}
	public function has_session() {
		return null !== $this->id;
	}
	public function set_customer_session_cookie( $set ) {
		$this->id = bin2hex( random_bytes( 16 ) );
		if ( ! headers_sent() && PHP_SAPI !== 'cli' ) {
			setcookie( 'stub_wc_session', $this->id, array( 'path' => '/', 'httponly' => true, 'samesite' => 'Lax' ) );
		}
	}
	public function get( $key ) {
		return $this->data[ $key ] ?? null;
	}
	public function set( $key, $value ) {
		$this->data[ $key ] = $value;
		if ( $this->id ) {
			update_option( 'stub_wc_session_' . $this->id, $this->data );
		}
	}
}

class Stub_WC_Cart {
	public function add_to_cart( $product_id, $quantity = 1, $variation_id = 0, $variation = array(), $data = array() ) {
		$lines   = (array) WC()->session->get( 'cart' );
		$lines[] = array( 'product_id' => $product_id, 'quantity' => $quantity, 'variation_id' => $variation_id, 'data' => $data, 'post' => $_POST );
		WC()->session->set( 'cart', $lines );
		return 'line-' . count( $lines );
	}
}

class Stub_WC {
	public $session = null;
	public $cart    = null;
	public function initialize_session() {
		$this->session = new Stub_WC_Session();
	}
}

function WC() {
	static $wc = null;
	if ( null === $wc ) {
		$wc = new Stub_WC();
	}
	return $wc;
}

function wc_load_cart() {
	WC()->cart = new Stub_WC_Cart();
}

class Stub_Product {
	public $id;
	public $purchasable;
	public function __construct( $id, $purchasable ) {
		$this->id          = $id;
		$this->purchasable = $purchasable;
	}
	public function is_purchasable() {
		return $this->purchasable;
	}
	public function is_type( $type ) {
		return false;
	}
	public function get_id() {
		return $this->id;
	}
}

/** Catalog: products from stub_catalog() (price and stock adjustable by the harness). */
function wc_get_product( $id ) {
	$catalog = stub_catalog();
	return isset( $catalog['ids'][ (int) $id ] ) ? new Stub_Product( (int) $id, $catalog['ids'][ (int) $id ]['in_stock'] ) : null;
}

function wc_get_product_id_by_sku( $sku ) {
	$catalog = stub_catalog();
	return isset( $catalog['skus'][ $sku ] ) ? $catalog['skus'][ $sku ]['id'] : 0;
}

function stub_catalog() {
	$catalog = get_option( 'stub_catalog', null );
	if ( null !== $catalog ) {
		return $catalog;
	}
	return array(
		'ids'  => array(
			4000  => array( 'name' => 'ClickBed O', 'price' => 1039000, 'in_stock' => true ),
			10759 => array( 'name' => 'ClickBed O Classico', 'price' => 1159000, 'in_stock' => true ),
			4184  => array( 'name' => 'ClickBed O Desk', 'price' => 1299000, 'in_stock' => true ),
		),
		'skus' => array(),
	);
}

function wc_add_notice( $message, $type = 'success' ) {
	if ( WC()->session ) {
		$notices   = (array) WC()->session->get( 'notices' );
		$notices[] = array( $type, $message );
		WC()->session->set( 'notices', $notices );
	}
}

function wc_get_cart_url() {
	return '/?harness=cart';
}

function wp_safe_redirect( $url ) {
	if ( PHP_SAPI !== 'cli' ) {
		header( 'Location: ' . $url, true, 302 );
	}
	$GLOBALS['stub_redirect'] = $url;
}

class Stub_Order {
	public $meta = array();
	public function update_meta_data( $key, $value ) {
		$this->meta[ $key ] = $value;
	}
	public function get_meta( $key ) {
		return $this->meta[ $key ] ?? '';
	}
}

/** Boots the plugin as WordPress would (plugins_loaded installs/upgrades the schema, then init, REST). */
function stub_boot_plugin() {
	require_once dirname( __DIR__, 2 ) . '/wordpress/multi3d-configurator/multi3d-configurator.php';
	do_action( 'plugins_loaded' );
	do_action( 'init' );
	do_action( 'rest_api_init' );
}
