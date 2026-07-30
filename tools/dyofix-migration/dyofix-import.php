<?php
/**
 * Dyofix history migration — customers + orders importer.
 *
 * Loads 7.5 years of iShop order history (customers.csv + orders.jsonl, produced by
 * the offline importer) into the Dyofix WooCommerce install.
 *
 * Run from the Dyofix webroot, never against salex:
 *   cd /var/www/dyofix/public_html
 *   wp --require=dyofix-import.php dyofix inspect  --orders=/path/orders.jsonl --allow-root
 *   wp --require=dyofix-import.php dyofix dry-run  --orders=... --customers=... --allow-root
 *   wp --require=dyofix-import.php dyofix customers --customers=... --allow-root
 *   wp --require=dyofix-import.php dyofix orders   --orders=... --allow-root
 *
 * Resumable and idempotent: every row carries its source id, and an already-imported
 * source id is skipped, so an interrupted run is restarted with the same command.
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	return;
}

/**
 * Field map: JSONL/CSV key => what the importer needs.
 *
 * The offline importer's exact key names were never written down, so `dyofix inspect`
 * prints the keys actually present in the file and every command validates against
 * this map before writing anything. Adjust the right-hand values, not the code.
 */
class Dyofix_Field_Map {

	/** Order-level keys, in preference order — first key present in the row wins. */
	public static $order = array(
		'id'       => array( 'order', 'order_number', 'orderNumber', 'order_id' ),
		'date'     => array( 'date', 'order_date', 'orderDate', 'created' ),
		'total'    => array( 'total', 'order_sum', 'orderSum', 'sum' ),
		'discount' => array( 'discount', 'order_discount', 'orderDiscount' ),
		'interest' => array( 'interest', 'order_interest', 'orderInterest', 'ribit' ),
		'payments' => array( 'payments', 'num_payments', 'numPayments' ),
		'email'    => array( 'email', 'mail' ),
		'first'    => array( 'first', 'first_name', 'firstName' ),
		'last'     => array( 'last', 'last_name', 'lastName' ),
		'phone'    => array( 'cell', 'phone', 'mobile', 'homePhone' ),
		'city'     => array( 'city' ),
		'street'   => array( 'street', 'address' ),
		'source'   => array( 'source', 'referrer' ),
		'lines'    => array( 'lines', 'items', 'line_items' ),
	);

	/** Line-level keys. */
	public static $line = array(
		'kind'  => array( 'kind', 'type', 'line_kind' ),
		'sku'   => array( 'sku', 'mkt', 'product_sku' ),
		'name'  => array( 'name', 'product_name', 'title' ),
		'qty'   => array( 'qty', 'quantity' ),
		'price' => array( 'price', 'unit_price', 'unitPrice' ),
	);

	/** Values of the `kind` field that mark a line as shipping / discount. */
	public static $shipping_kinds = array( 'shipping', 'delivery', 'e-post' );
	public static $discount_kinds = array( 'discount', 'fee', 'promo' );

	/** Pull a mapped field out of a row. */
	public static function get( array $row, array $map, $field, $default = null ) {
		if ( ! isset( $map[ $field ] ) ) {
			return $default;
		}
		foreach ( $map[ $field ] as $key ) {
			if ( array_key_exists( $key, $row ) && '' !== $row[ $key ] && null !== $row[ $key ] ) {
				return $row[ $key ];
			}
		}
		return $default;
	}

	/**
	 * Fields that must resolve or the import is meaningless. Everything else degrades.
	 */
	public static function required() {
		return array( 'id', 'date', 'total', 'lines' );
	}
}

class Dyofix_Import_Command {

	const META_SRC_ORDER    = '_dyofix_src_order';
	const META_SRC_CUSTOMER = '_dyofix_src_customer';
	const META_SRC_SKU      = '_dyofix_src_sku';

	/** Rows per batch, then a short pause, to keep the Dyofix box responsive. */
	private $batch_size = 500;
	private $batch_pause_us = 250000;

	/**
	 * Refuse to run anywhere but Dyofix.
	 *
	 * Salex lives on a different server and must never be written to by this importer.
	 * Every write command calls this first: a wrong --path, a wrong wp-config, or the
	 * command being run from the wrong shell all abort here instead of touching salex.
	 */
	private function assert_dyofix_target() {
		$home    = strtolower( (string) get_option( 'home' ) );
		$siteurl = strtolower( (string) get_option( 'siteurl' ) );
		$db      = strtolower( defined( 'DB_NAME' ) ? DB_NAME : '' );
		$root    = strtolower( defined( 'ABSPATH' ) ? ABSPATH : '' );
		$haystack = "$home $siteurl $db $root";

		foreach ( array( 'salex' ) as $forbidden ) {
			if ( false !== strpos( $haystack, $forbidden ) ) {
				WP_CLI::error( sprintf(
					"REFUSING TO RUN: this install looks like salex (home=%s db=%s abspath=%s). "
					. 'This importer only ever writes to Dyofix.',
					$home, $db, $root
				) );
			}
		}

		$looks_like_dyofix = false !== strpos( $haystack, 'dyofix' );
		if ( ! $looks_like_dyofix ) {
			WP_CLI::error( sprintf(
				"REFUSING TO RUN: cannot confirm this is the Dyofix install (home=%s db=%s abspath=%s). "
				. 'Expected "dyofix" in the site URL, database name, or webroot.',
				$home, $db, $root
			) );
		}

		WP_CLI::log( sprintf( 'Target confirmed: home=%s db=%s', $home, $db ) );
	}

	/**
	 * Print the keys actually present in the source files.
	 *
	 * ## OPTIONS
	 *
	 * [--orders=<file>]
	 * : Path to orders.jsonl.
	 *
	 * [--customers=<file>]
	 * : Path to customers.csv.
	 *
	 * [--sample=<n>]
	 * : Rows to scan. Default 200.
	 */
	public function inspect( $args, $assoc ) {
		$sample = isset( $assoc['sample'] ) ? (int) $assoc['sample'] : 200;

		if ( ! empty( $assoc['orders'] ) ) {
			$path = $this->require_file( $assoc['orders'] );
			$order_keys = array();
			$line_keys  = array();
			$kinds      = array();
			$n          = 0;

			foreach ( $this->read_jsonl( $path ) as $row ) {
				foreach ( array_keys( $row ) as $k ) {
					$order_keys[ $k ] = ( $order_keys[ $k ] ?? 0 ) + 1;
				}
				$lines = Dyofix_Field_Map::get( $row, Dyofix_Field_Map::$order, 'lines', array() );
				if ( is_array( $lines ) ) {
					foreach ( $lines as $line ) {
						if ( ! is_array( $line ) ) {
							continue;
						}
						foreach ( array_keys( $line ) as $k ) {
							$line_keys[ $k ] = ( $line_keys[ $k ] ?? 0 ) + 1;
						}
						$kind = Dyofix_Field_Map::get( $line, Dyofix_Field_Map::$line, 'kind' );
						if ( null !== $kind ) {
							$kinds[ (string) $kind ] = ( $kinds[ (string) $kind ] ?? 0 ) + 1;
						}
					}
				}
				if ( ++$n >= $sample ) {
					break;
				}
			}

			WP_CLI::log( sprintf( "orders.jsonl — scanned %d rows", $n ) );
			WP_CLI::log( '  order keys: ' . implode( ', ', array_keys( $order_keys ) ) );
			WP_CLI::log( '  line keys : ' . implode( ', ', array_keys( $line_keys ) ) );
			WP_CLI::log( '  line kinds: ' . json_encode( $kinds, JSON_UNESCAPED_UNICODE ) );
			$this->report_map_resolution( $order_keys, $line_keys );
		}

		if ( ! empty( $assoc['customers'] ) ) {
			$path = $this->require_file( $assoc['customers'] );
			$fh   = fopen( $path, 'r' );
			$head = fgetcsv( $fh );
			fclose( $fh );
			WP_CLI::log( 'customers.csv header: ' . implode( ', ', (array) $head ) );
		}
	}

	/** Which mapped fields resolve against the real keys. */
	private function report_map_resolution( $order_keys, $line_keys ) {
		WP_CLI::log( '  field map resolution:' );
		foreach ( Dyofix_Field_Map::$order as $field => $candidates ) {
			$hit = null;
			foreach ( $candidates as $c ) {
				if ( isset( $order_keys[ $c ] ) ) {
					$hit = $c;
					break;
				}
			}
			$required = in_array( $field, Dyofix_Field_Map::required(), true );
			if ( null === $hit && $required ) {
				WP_CLI::warning( sprintf( '    order.%s => UNRESOLVED (required)', $field ) );
			} else {
				WP_CLI::log( sprintf( '    order.%-9s => %s', $field, $hit ?: '(none)' ) );
			}
		}
		foreach ( Dyofix_Field_Map::$line as $field => $candidates ) {
			$hit = null;
			foreach ( $candidates as $c ) {
				if ( isset( $line_keys[ $c ] ) ) {
					$hit = $c;
					break;
				}
			}
			WP_CLI::log( sprintf( '    line.%-9s => %s', $field, $hit ?: '(none)' ) );
		}
	}

	/**
	 * Parse and validate everything, write nothing. Reconciles line sums against the
	 * authoritative order total and reports where they disagree.
	 *
	 * ## OPTIONS
	 *
	 * [--orders=<file>]
	 * : Path to orders.jsonl.
	 *
	 * [--customers=<file>]
	 * : Path to customers.csv.
	 *
	 * [--limit=<n>]
	 * : Stop after n orders.
	 *
	 * [--tolerance=<x>]
	 * : Currency delta tolerated before an order counts as mismatched. Default 1.0.
	 */
	public function dry_run( $args, $assoc ) {
		$tolerance = isset( $assoc['tolerance'] ) ? (float) $assoc['tolerance'] : 1.0;
		$limit     = isset( $assoc['limit'] ) ? (int) $assoc['limit'] : 0;
		$path      = $this->require_file( $assoc['orders'] ?? '' );

		$stats = array(
			'orders' => 0, 'product' => 0, 'shipping' => 0, 'discount' => 0,
			'unknown_kind' => 0, 'no_email' => 0, 'bad_date' => 0, 'missing_field' => 0,
			'mismatch' => 0, 'mismatch_explained_by_interest' => 0, 'mismatch_abs_sum' => 0.0,
		);
		$worst = array();

		foreach ( $this->read_jsonl( $path ) as $row ) {
			$parsed = $this->parse_order( $row );
			if ( is_wp_error( $parsed ) ) {
				$stats['missing_field']++;
				continue;
			}
			$stats['orders']++;
			$stats['product']  += count( $parsed['products'] );
			$stats['shipping'] += count( $parsed['shipping'] );
			$stats['discount'] += count( $parsed['fees'] );
			$stats['unknown_kind'] += $parsed['unknown_kind'];
			if ( '' === $parsed['email'] ) {
				$stats['no_email']++;
			}
			if ( ! $parsed['date'] ) {
				$stats['bad_date']++;
			}

			$delta = round( $parsed['total'] - $parsed['line_sum'], 2 );
			if ( abs( $delta ) > $tolerance ) {
				$stats['mismatch']++;
				$stats['mismatch_abs_sum'] += abs( $delta );
				// Leading hypothesis for the known 15.49%: order-level interest and
				// discount columns exist in the source header but were never emitted
				// as lines. If they account for the delta, this counts them.
				$explained = round( $parsed['interest'] - $parsed['order_discount'], 2 );
				if ( $explained && abs( $delta - $explained ) <= $tolerance ) {
					$stats['mismatch_explained_by_interest']++;
				} elseif ( count( $worst ) < 15 ) {
					$worst[] = sprintf(
						'  order %s  total=%.2f lines=%.2f delta=%+.2f interest=%.2f discount=%.2f',
						$parsed['src_id'], $parsed['total'], $parsed['line_sum'],
						$delta, $parsed['interest'], $parsed['order_discount']
					);
				}
			}

			if ( $limit && $stats['orders'] >= $limit ) {
				break;
			}
		}

		WP_CLI::log( '--- dry run ---' );
		foreach ( $stats as $k => $v ) {
			WP_CLI::log( sprintf( '  %-32s %s', $k, is_float( $v ) ? number_format( $v, 2 ) : $v ) );
		}
		if ( $stats['mismatch'] ) {
			$pct = 100 * $stats['mismatch'] / max( 1, $stats['orders'] );
			WP_CLI::log( sprintf( '  mismatch rate: %.2f%%', $pct ) );
			if ( $worst ) {
				WP_CLI::log( '  unexplained samples:' );
				foreach ( $worst as $w ) {
					WP_CLI::log( $w );
				}
			}
		}
		WP_CLI::success( 'Dry run complete. Nothing was written.' );
	}

	/**
	 * Create customer accounts for source rows that carry an email.
	 *
	 * No passwords are set — iShop hashes are not migratable, so first login goes
	 * through password reset.
	 *
	 * ## OPTIONS
	 *
	 * [--customers=<file>]
	 * : Path to customers.csv.
	 *
	 * [--limit=<n>]
	 * : Stop after n customers.
	 */
	public function customers( $args, $assoc ) {
		$this->assert_dyofix_target();
		$path  = $this->require_file( $assoc['customers'] ?? '' );
		$limit = isset( $assoc['limit'] ) ? (int) $assoc['limit'] : 0;

		$this->quiet_wordpress();

		$fh     = fopen( $path, 'r' );
		$header = fgetcsv( $fh );
		if ( ! $header ) {
			WP_CLI::error( 'customers.csv has no header row.' );
		}
		$col = array_flip( array_map( 'trim', $header ) );
		$pick = function ( $row, array $names ) use ( $col ) {
			foreach ( $names as $n ) {
				if ( isset( $col[ $n ] ) && isset( $row[ $col[ $n ] ] ) && '' !== $row[ $col[ $n ] ] ) {
					return trim( $row[ $col[ $n ] ] );
				}
			}
			return '';
		};

		$created = $skipped = $invalid = 0;
		$n = 0;

		while ( false !== ( $row = fgetcsv( $fh ) ) ) {
			$email = strtolower( $pick( $row, array( 'email', 'mail', 'דואל' ) ) );
			if ( ! $email || ! is_email( $email ) ) {
				$invalid++;
				continue;
			}
			if ( email_exists( $email ) ) {
				$skipped++;
				continue;
			}

			$first = $pick( $row, array( 'first', 'first_name', 'firstName' ) );
			$last  = $pick( $row, array( 'last', 'last_name', 'lastName' ) );
			$phone = $pick( $row, array( 'cell', 'phone', 'mobile' ) );
			$city  = $pick( $row, array( 'city' ) );

			$user_id = wp_insert_user( array(
				'user_login'   => $this->unique_login( $email ),
				'user_email'   => $email,
				'user_pass'    => wp_generate_password( 32, true, true ),
				'first_name'   => $first,
				'last_name'    => $last,
				'display_name' => trim( "$first $last" ) ?: $email,
				'role'         => 'customer',
			) );

			if ( is_wp_error( $user_id ) ) {
				$invalid++;
				continue;
			}

			update_user_meta( $user_id, self::META_SRC_CUSTOMER, $email );
			update_user_meta( $user_id, 'billing_email', $email );
			if ( $first ) { update_user_meta( $user_id, 'billing_first_name', $first ); }
			if ( $last )  { update_user_meta( $user_id, 'billing_last_name', $last ); }
			if ( $phone ) { update_user_meta( $user_id, 'billing_phone', $phone ); }
			if ( $city )  { update_user_meta( $user_id, 'billing_city', $city ); }

			$created++;
			if ( 0 === ++$n % $this->batch_size ) {
				$this->breathe( $n, 'customers' );
			}
			if ( $limit && $n >= $limit ) {
				break;
			}
		}
		fclose( $fh );

		$this->restore_wordpress();
		WP_CLI::success( sprintf(
			'customers: created=%d skipped_existing=%d invalid=%d', $created, $skipped, $invalid
		) );
	}

	/**
	 * Import orders. Resumable — already-imported source ids are skipped.
	 *
	 * ## OPTIONS
	 *
	 * [--orders=<file>]
	 * : Path to orders.jsonl.
	 *
	 * [--limit=<n>]
	 * : Stop after n newly imported orders.
	 *
	 * [--status=<status>]
	 * : Order status. Default completed.
	 */
	public function orders( $args, $assoc ) {
		$this->assert_dyofix_target();
		$path   = $this->require_file( $assoc['orders'] ?? '' );
		$limit  = isset( $assoc['limit'] ) ? (int) $assoc['limit'] : 0;
		$status = $assoc['status'] ?? 'completed';

		$this->quiet_wordpress();

		WP_CLI::log( 'Loading already-imported source ids...' );
		$done = $this->imported_source_ids();
		WP_CLI::log( sprintf( '  %d orders already present, they will be skipped.', count( $done ) ) );

		$imported = $skipped = $failed = 0;
		$started  = time();

		foreach ( $this->read_jsonl( $path ) as $row ) {
			$parsed = $this->parse_order( $row );
			if ( is_wp_error( $parsed ) ) {
				$failed++;
				continue;
			}
			if ( isset( $done[ $parsed['src_id'] ] ) ) {
				$skipped++;
				continue;
			}

			try {
				$this->create_order( $parsed, $status );
				$imported++;
			} catch ( Exception $e ) {
				$failed++;
				WP_CLI::warning( sprintf( 'order %s failed: %s', $parsed['src_id'], $e->getMessage() ) );
			}

			if ( 0 === $imported % $this->batch_size && $imported ) {
				$rate = $imported / max( 1, time() - $started );
				$this->breathe( $imported, sprintf( 'orders (%.1f/s)', $rate ) );
			}
			if ( $limit && $imported >= $limit ) {
				break;
			}
		}

		$this->restore_wordpress();
		WP_CLI::success( sprintf(
			'orders: imported=%d skipped=%d failed=%d in %ds',
			$imported, $skipped, $failed, time() - $started
		) );
	}

	/**
	 * Re-link imported line items to catalog products once the catalog is loaded.
	 *
	 * Every line item keeps its source SKU, so this is a cheap second pass and is the
	 * reason importing history before the catalog costs almost nothing.
	 *
	 * ## OPTIONS
	 *
	 * [--dry-run]
	 * : Report what would be linked.
	 */
	public function relink( $args, $assoc ) {
		global $wpdb;
		$dry = isset( $assoc['dry-run'] );
		if ( ! $dry ) {
			$this->assert_dyofix_target();
		}

		$rows = $wpdb->get_results( $wpdb->prepare(
			"SELECT im.meta_id, im.order_item_id, im.meta_value AS sku
			   FROM {$wpdb->prefix}woocommerce_order_itemmeta im
			  WHERE im.meta_key = %s",
			self::META_SRC_SKU
		) );

		$linked = $missing = 0;
		foreach ( $rows as $r ) {
			$product_id = wc_get_product_id_by_sku( $r->sku );
			if ( ! $product_id ) {
				$missing++;
				continue;
			}
			if ( ! $dry ) {
				wc_update_order_item_meta( $r->order_item_id, '_product_id', $product_id );
			}
			$linked++;
		}

		WP_CLI::success( sprintf(
			'%s linked=%d no_matching_sku=%d', $dry ? '[dry-run]' : 'relink', $linked, $missing
		) );
	}

	// ---------------------------------------------------------------- internals

	/** Normalise one source row into the shape create_order() needs. */
	private function parse_order( $row ) {
		$m = Dyofix_Field_Map::$order;

		$src_id = Dyofix_Field_Map::get( $row, $m, 'id' );
		$total  = Dyofix_Field_Map::get( $row, $m, 'total' );
		$lines  = Dyofix_Field_Map::get( $row, $m, 'lines' );

		if ( null === $src_id || null === $total || ! is_array( $lines ) ) {
			return new WP_Error( 'dyofix_missing_field', 'required field unresolved' );
		}

		$products = $shipping = $fees = array();
		$line_sum = 0.0;
		$unknown  = 0;

		foreach ( $lines as $line ) {
			if ( ! is_array( $line ) ) {
				continue;
			}
			$lm    = Dyofix_Field_Map::$line;
			$kind  = strtolower( (string) Dyofix_Field_Map::get( $line, $lm, 'kind', '' ) );
			$sku   = (string) Dyofix_Field_Map::get( $line, $lm, 'sku', '' );
			$name  = (string) Dyofix_Field_Map::get( $line, $lm, 'name', '' );
			$qty   = (float) Dyofix_Field_Map::get( $line, $lm, 'qty', 1 );
			$price = (float) Dyofix_Field_Map::get( $line, $lm, 'price', 0 );

			// Fall back to shape when `kind` is absent: the source marks discounts with
			// SKU -9999 and a negative price, and shipping with E-Post / delivery*.
			if ( '' === $kind ) {
				if ( '-9999' === trim( $sku ) || $price < 0 ) {
					$kind = 'discount';
				} elseif ( preg_match( '/^(e-post|delivery)/i', $sku . $name ) ) {
					$kind = 'shipping';
				} else {
					$kind = 'product';
				}
			}

			$line_total = round( $qty * $price, 2 );

			if ( in_array( $kind, Dyofix_Field_Map::$shipping_kinds, true ) ) {
				$shipping[] = compact( 'name', 'line_total' );
			} elseif ( in_array( $kind, Dyofix_Field_Map::$discount_kinds, true ) ) {
				$fees[] = compact( 'name', 'line_total' );
			} elseif ( 'product' === $kind ) {
				$products[] = compact( 'sku', 'name', 'qty', 'price', 'line_total' );
			} else {
				$unknown++;
				$products[] = compact( 'sku', 'name', 'qty', 'price', 'line_total' );
			}
			$line_sum += $line_total;
		}

		$raw_date = (string) Dyofix_Field_Map::get( $row, $m, 'date', '' );

		return array(
			'src_id'         => (string) $src_id,
			'total'          => (float) $total,           // c2 is authoritative
			'line_sum'       => round( $line_sum, 2 ),
			'order_discount' => (float) Dyofix_Field_Map::get( $row, $m, 'discount', 0 ),
			'interest'       => (float) Dyofix_Field_Map::get( $row, $m, 'interest', 0 ),
			'payments'       => (int) Dyofix_Field_Map::get( $row, $m, 'payments', 1 ),
			'date'           => $this->parse_date( $raw_date ),
			'email'          => strtolower( trim( (string) Dyofix_Field_Map::get( $row, $m, 'email', '' ) ) ),
			'first'          => (string) Dyofix_Field_Map::get( $row, $m, 'first', '' ),
			'last'           => (string) Dyofix_Field_Map::get( $row, $m, 'last', '' ),
			'phone'          => (string) Dyofix_Field_Map::get( $row, $m, 'phone', '' ),
			'city'           => (string) Dyofix_Field_Map::get( $row, $m, 'city', '' ),
			'street'         => (string) Dyofix_Field_Map::get( $row, $m, 'street', '' ),
			'source'         => (string) Dyofix_Field_Map::get( $row, $m, 'source', '' ),
			'products'       => $products,
			'shipping'       => $shipping,
			'fees'           => $fees,
			'unknown_kind'   => $unknown,
		);
	}

	/** Build and persist one WooCommerce order. */
	private function create_order( array $p, $status ) {
		$order = new WC_Order();

		$order->set_created_via( 'dyofix-migration' );
		$order->set_currency( 'ILS' );
		$order->set_prices_include_tax( true );

		if ( $p['date'] ) {
			$order->set_date_created( $p['date'] );
		}

		$order->set_billing_first_name( $p['first'] );
		$order->set_billing_last_name( $p['last'] );
		$order->set_billing_city( $p['city'] );
		$order->set_billing_address_1( $p['street'] );
		$order->set_billing_country( 'IL' );
		if ( $p['phone'] ) {
			$order->set_billing_phone( $p['phone'] );
		}

		// Email present => attach to the migrated account. Absent => guest order,
		// staff-visible, no account, per the migration decision.
		if ( $p['email'] ) {
			$order->set_billing_email( $p['email'] );
			$user = get_user_by( 'email', $p['email'] );
			if ( $user ) {
				$order->set_customer_id( $user->ID );
			}
		}

		foreach ( $p['products'] as $line ) {
			$item = new WC_Order_Item_Product();
			$item->set_name( $line['name'] ?: ( $line['sku'] ?: 'פריט' ) );
			$item->set_quantity( max( 1, (int) $line['qty'] ) );
			$item->set_subtotal( $line['line_total'] );
			$item->set_total( $line['line_total'] );
			// Catalog is not loaded yet, so nothing to point at — keep the SKU so
			// `dyofix relink` can attach the product later in one pass.
			$item->set_product_id( 0 );
			if ( '' !== $line['sku'] ) {
				$item->add_meta_data( self::META_SRC_SKU, $line['sku'], true );
			}
			$order->add_item( $item );
		}

		foreach ( $p['shipping'] as $line ) {
			$item = new WC_Order_Item_Shipping();
			$item->set_method_title( $line['name'] ?: 'משלוח' );
			$item->set_total( $line['line_total'] );
			$order->add_item( $item );
		}

		foreach ( $p['fees'] as $line ) {
			$item = new WC_Order_Item_Fee();
			$item->set_name( $line['name'] ?: 'הנחה' );
			$item->set_total( $line['line_total'] ); // negative for discounts
			$order->add_item( $item );
		}

		// Never recalculate: the source order sum is authoritative, line arithmetic is not.
		$order->set_total( $p['total'] );
		$order->set_status( $status );

		$order->add_meta_data( self::META_SRC_ORDER, $p['src_id'], true );
		if ( $p['source'] ) {
			$order->add_meta_data( '_dyofix_src_channel', $p['source'], true );
		}
		if ( $p['payments'] > 1 ) {
			$order->add_meta_data( '_dyofix_src_payments', $p['payments'], true );
		}
		$delta = round( $p['total'] - $p['line_sum'], 2 );
		if ( abs( $delta ) > 1.0 ) {
			// Flagged rather than silently absorbed, so the 15.49% stays auditable in place.
			$order->add_meta_data( '_dyofix_total_delta', $delta, true );
		}

		$order->save();
		return $order->get_id();
	}

	/** Source ids already in the store, for resume. */
	private function imported_source_ids() {
		global $wpdb;
		$out   = array();
		$table = "{$wpdb->prefix}wc_orders_meta";

		if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) === $table ) {
			$rows = $wpdb->get_col( $wpdb->prepare(
				"SELECT meta_value FROM {$table} WHERE meta_key = %s", self::META_SRC_ORDER
			) );
		} else {
			$rows = $wpdb->get_col( $wpdb->prepare(
				"SELECT meta_value FROM {$wpdb->postmeta} WHERE meta_key = %s", self::META_SRC_ORDER
			) );
		}
		foreach ( $rows as $r ) {
			$out[ (string) $r ] = true;
		}
		return $out;
	}

	/** Stream a JSONL file without loading 164MB into memory. */
	private function read_jsonl( $path ) {
		$fh = fopen( $path, 'r' );
		if ( ! $fh ) {
			WP_CLI::error( "cannot open $path" );
		}
		$n = 0;
		while ( false !== ( $line = fgets( $fh ) ) ) {
			$n++;
			$line = trim( $line );
			if ( '' === $line ) {
				continue;
			}
			$row = json_decode( $line, true );
			if ( ! is_array( $row ) ) {
				WP_CLI::warning( "line $n is not valid JSON, skipped" );
				continue;
			}
			yield $row;
		}
		fclose( $fh );
	}

	private function parse_date( $raw ) {
		$raw = trim( $raw );
		if ( '' === $raw ) {
			return null;
		}
		// Source is Israeli d/m/Y; strtotime would read that as m/d/Y.
		if ( preg_match( '#^(\d{1,2})/(\d{1,2})/(\d{4})#', $raw, $mm ) ) {
			return sprintf( '%04d-%02d-%02d 00:00:00', $mm[3], $mm[2], $mm[1] );
		}
		$ts = strtotime( $raw );
		return $ts ? gmdate( 'Y-m-d H:i:s', $ts ) : null;
	}

	private function unique_login( $email ) {
		$base  = sanitize_user( current( explode( '@', $email ) ), true );
		$base  = $base ?: 'customer';
		$login = $base;
		$i     = 1;
		while ( username_exists( $login ) ) {
			$login = $base . '_' . ( ++$i );
		}
		return $login;
	}

	/** Silence everything that would make a bulk import slow or noisy. */
	private function quiet_wordpress() {
		if ( ! defined( 'WP_IMPORTING' ) ) {
			define( 'WP_IMPORTING', true );
		}
		// No customer gets seven years of email about their own history.
		add_filter( 'woocommerce_email_enabled_customer_completed_order', '__return_false' );
		add_filter( 'woocommerce_email_enabled_customer_processing_order', '__return_false' );
		add_filter( 'woocommerce_email_enabled_customer_on_hold_order', '__return_false' );
		add_filter( 'woocommerce_email_enabled_new_order', '__return_false' );
		add_filter( 'woocommerce_allow_send_queued_transactional_email', '__return_false' );
		add_filter( 'wp_mail', function ( $a ) { $a['to'] = array(); return $a; }, 999 );
		add_filter( 'send_password_change_email', '__return_false' );
		add_filter( 'send_email_change_email', '__return_false' );
		add_filter( 'woocommerce_new_customer_note_notification', '__return_false' );

		// Migrated history must not touch supplier availability flags.
		add_filter( 'woocommerce_can_reduce_order_stock', '__return_false' );

		remove_all_actions( 'woocommerce_after_order_object_save' );

		// Do not queue 133k Elasticsearch syncs behind the import.
		if ( class_exists( 'ElasticPress\\Elasticsearch' ) ) {
			remove_all_actions( 'ep_sync_on_meta_update' );
			add_filter( 'ep_skip_action_edited_term', '__return_true' );
		}

		wp_defer_term_counting( true );
		wp_defer_comment_counting( true );
	}

	private function restore_wordpress() {
		wp_defer_term_counting( false );
		wp_defer_comment_counting( false );
	}

	/** Flush caches and pause so the shared MariaDB keeps serving salex. */
	private function breathe( $n, $label ) {
		global $wpdb;
		$wpdb->queries = array();
		if ( function_exists( 'wp_cache_flush_runtime' ) ) {
			wp_cache_flush_runtime();
		}
		WP_CLI::log( sprintf( '  ... %d %s (mem %s)', $n, $label, size_format( memory_get_usage( true ) ) ) );
		usleep( $this->batch_pause_us );
	}

	private function require_file( $path ) {
		if ( ! $path ) {
			WP_CLI::error( 'missing --orders / --customers path' );
		}
		if ( ! is_readable( $path ) ) {
			WP_CLI::error( "cannot read $path" );
		}
		return $path;
	}
}

WP_CLI::add_command( 'dyofix', 'Dyofix_Import_Command' );
