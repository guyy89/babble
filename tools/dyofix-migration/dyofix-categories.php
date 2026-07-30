<?php
/**
 * Recreate the SaleX product_cat tree on Dyofix, identically.
 *
 * Input is salex-categories.json — 140 categories exported from the SaleX public
 * Store API, keyed by slug with parents referenced by slug (term IDs are not
 * portable between installs).
 *
 *   cd /var/www/dyofix/public_html
 *   wp --require=dyofix-categories.php dyofix-cat build --file=salex-categories.json --dry-run --allow-root
 *   wp --require=dyofix-categories.php dyofix-cat build --file=salex-categories.json --allow-root
 *   wp --require=dyofix-categories.php dyofix-cat images --file=salex-categories.json --allow-root
 *   wp --require=dyofix-categories.php dyofix-cat verify --file=salex-categories.json --allow-root
 *
 * Idempotent: an existing slug is left alone, so a partial run is resumed by
 * repeating the command.
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	return;
}

class Dyofix_Category_Command {

	/**
	 * Refuse to run anywhere but Dyofix.
	 *
	 * SaleX is on a different server and is only ever read from, never written to.
	 * Identical to the guard in dyofix-import.php — a wrong --path aborts here.
	 */
	private function assert_dyofix_target() {
		$home    = strtolower( (string) get_option( 'home' ) );
		$siteurl = strtolower( (string) get_option( 'siteurl' ) );
		$db      = strtolower( defined( 'DB_NAME' ) ? DB_NAME : '' );
		$root    = strtolower( defined( 'ABSPATH' ) ? ABSPATH : '' );
		$haystack = "$home $siteurl $db $root";

		if ( false !== strpos( $haystack, 'salex' ) ) {
			WP_CLI::error( sprintf(
				'REFUSING TO RUN: this install looks like salex (home=%s db=%s abspath=%s).',
				$home, $db, $root
			) );
		}
		if ( false === strpos( $haystack, 'dyofix' ) ) {
			WP_CLI::error( sprintf(
				'REFUSING TO RUN: cannot confirm this is the Dyofix install (home=%s db=%s abspath=%s).',
				$home, $db, $root
			) );
		}
		WP_CLI::log( sprintf( 'Target confirmed: home=%s db=%s', $home, $db ) );
	}

	/**
	 * Create the category tree, parents before children.
	 *
	 * ## OPTIONS
	 *
	 * --file=<path>
	 * : salex-categories.json
	 *
	 * [--dry-run]
	 * : Report what would be created.
	 */
	public function build( $args, $assoc ) {
		$dry  = isset( $assoc['dry-run'] );
		if ( ! $dry ) {
			$this->assert_dyofix_target();
		}
		$cats = $this->load( $assoc['file'] ?? '' );

		// Resolve in waves: a category is creatable once its parent exists.
		$slug_to_id = array();
		foreach ( get_terms( array( 'taxonomy' => 'product_cat', 'hide_empty' => false ) ) as $t ) {
			$slug_to_id[ urldecode( $t->slug ) ] = $t->term_id;
		}

		$pending = $cats;
		$created = $existing = 0;
		$pass    = 0;

		while ( $pending && $pass < 10 ) {
			$pass++;
			$next = array();
			foreach ( $pending as $c ) {
				$parent_slug = $c['parent_slug'];
				if ( '' !== $parent_slug && ! isset( $slug_to_id[ $parent_slug ] ) ) {
					$next[] = $c; // parent not created yet, try next wave
					continue;
				}
				$parent_id = '' === $parent_slug ? 0 : $slug_to_id[ $parent_slug ];

				if ( isset( $slug_to_id[ $c['slug'] ] ) ) {
					$existing++;
					continue;
				}

				if ( $dry ) {
					WP_CLI::log( sprintf(
						'  would create: %-40s parent=%s', $c['name'], $parent_slug ?: '(root)'
					) );
					$slug_to_id[ $c['slug'] ] = -1; // pretend, so children resolve
					$created++;
					continue;
				}

				$res = wp_insert_term( $c['name'], 'product_cat', array(
					'slug'        => $c['slug'],
					'parent'      => $parent_id,
					'description' => $c['description'],
				) );

				if ( is_wp_error( $res ) ) {
					WP_CLI::warning( sprintf( '%s: %s', $c['name'], $res->get_error_message() ) );
					continue;
				}
				$slug_to_id[ $c['slug'] ] = $res['term_id'];
				$created++;
			}
			if ( count( $next ) === count( $pending ) ) {
				break; // no progress — remaining parents are unreachable
			}
			$pending = $next;
		}

		if ( $pending ) {
			WP_CLI::warning( sprintf( '%d categories unresolved (missing parent):', count( $pending ) ) );
			foreach ( $pending as $c ) {
				WP_CLI::log( sprintf( '    %s -> parent %s', $c['slug'], $c['parent_slug'] ) );
			}
		}

		WP_CLI::success( sprintf(
			'%screated=%d already_present=%d unresolved=%d',
			$dry ? '[dry-run] ' : '', $created, $existing, count( $pending )
		) );
	}

	/**
	 * Copy the 140 category icons across from SaleX and attach them.
	 *
	 * The rebuild plan assumed a shared uploads directory via symlink, which is not
	 * possible now that the two stores are on separate servers — the images have to
	 * be fetched over HTTP and stored in the Dyofix media library.
	 *
	 * ## OPTIONS
	 *
	 * --file=<path>
	 * : salex-categories.json
	 *
	 * [--dry-run]
	 * : Report what would be fetched.
	 *
	 * [--force]
	 * : Re-fetch even when the category already has an image.
	 */
	public function images( $args, $assoc ) {
		$dry = isset( $assoc['dry-run'] );
		if ( ! $dry ) {
			$this->assert_dyofix_target();
		}
		$cats = $this->load( $assoc['file'] ?? '' );
		$force = isset( $assoc['force'] );

		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';

		$done = $skipped = $failed = 0;

		foreach ( $cats as $c ) {
			if ( '' === $c['image'] ) {
				continue;
			}
			$term = get_term_by( 'slug', $c['slug'], 'product_cat' );
			if ( ! $term ) {
				WP_CLI::warning( sprintf( 'no such category yet: %s', $c['slug'] ) );
				$failed++;
				continue;
			}
			if ( ! $force && get_term_meta( $term->term_id, 'thumbnail_id', true ) ) {
				$skipped++;
				continue;
			}
			if ( $dry ) {
				WP_CLI::log( sprintf( '  would fetch %s -> %s', basename( $c['image'] ), $c['name'] ) );
				$done++;
				continue;
			}

			$attachment_id = media_sideload_image( $c['image'], 0, $c['name'], 'id' );
			if ( is_wp_error( $attachment_id ) ) {
				WP_CLI::warning( sprintf( '%s: %s', $c['name'], $attachment_id->get_error_message() ) );
				$failed++;
				continue;
			}
			update_term_meta( $term->term_id, 'thumbnail_id', $attachment_id );
			$done++;
			usleep( 200000 ); // gentle on the SaleX box, which is serving live traffic
		}

		WP_CLI::success( sprintf(
			'%simages=%d already_set=%d failed=%d', $dry ? '[dry-run] ' : '', $done, $skipped, $failed
		) );
	}

	/**
	 * Compare the Dyofix tree against the exported SaleX tree.
	 *
	 * ## OPTIONS
	 *
	 * --file=<path>
	 * : salex-categories.json
	 */
	public function verify( $args, $assoc ) {
		$cats = $this->load( $assoc['file'] ?? '' );
		$want = array();
		foreach ( $cats as $c ) {
			$want[ $c['slug'] ] = $c;
		}

		$have = array();
		foreach ( get_terms( array( 'taxonomy' => 'product_cat', 'hide_empty' => false ) ) as $t ) {
			$have[ urldecode( $t->slug ) ] = $t;
		}

		$missing = array_diff_key( $want, $have );
		$extra   = array_diff_key( $have, $want );
		$wrong_parent = array();
		$no_image     = array();

		foreach ( $want as $slug => $c ) {
			if ( ! isset( $have[ $slug ] ) ) {
				continue;
			}
			$t = $have[ $slug ];
			$parent_slug = '';
			if ( $t->parent ) {
				$p = get_term( $t->parent, 'product_cat' );
				$parent_slug = $p && ! is_wp_error( $p ) ? urldecode( $p->slug ) : '?';
			}
			if ( $parent_slug !== $c['parent_slug'] ) {
				$wrong_parent[] = sprintf( '%s: parent=%s expected=%s', $slug, $parent_slug ?: '(root)', $c['parent_slug'] ?: '(root)' );
			}
			if ( '' !== $c['image'] && ! get_term_meta( $t->term_id, 'thumbnail_id', true ) ) {
				$no_image[] = $slug;
			}
		}

		WP_CLI::log( sprintf( 'expected %d categories, found %d', count( $want ), count( $have ) ) );
		WP_CLI::log( sprintf( '  missing        : %d', count( $missing ) ) );
		WP_CLI::log( sprintf( '  unexpected     : %d', count( $extra ) ) );
		WP_CLI::log( sprintf( '  wrong parent   : %d', count( $wrong_parent ) ) );
		WP_CLI::log( sprintf( '  without icon   : %d', count( $no_image ) ) );

		foreach ( array_slice( array_keys( $missing ), 0, 20 ) as $s ) {
			WP_CLI::log( "    missing: $s" );
		}
		foreach ( array_slice( array_keys( $extra ), 0, 20 ) as $s ) {
			WP_CLI::log( "    unexpected: $s" );
		}
		foreach ( array_slice( $wrong_parent, 0, 20 ) as $s ) {
			WP_CLI::log( "    $s" );
		}

		if ( ! $missing && ! $extra && ! $wrong_parent ) {
			WP_CLI::success( 'Tree matches SaleX exactly.' );
		} else {
			WP_CLI::warning( 'Tree does not match.' );
		}
	}

	private function load( $file ) {
		if ( ! $file || ! is_readable( $file ) ) {
			WP_CLI::error( "cannot read --file=$file" );
		}
		$cats = json_decode( file_get_contents( $file ), true );
		if ( ! is_array( $cats ) || ! $cats ) {
			WP_CLI::error( 'category file is empty or not valid JSON' );
		}
		foreach ( $cats as $c ) {
			foreach ( array( 'slug', 'name', 'parent_slug' ) as $k ) {
				if ( ! array_key_exists( $k, $c ) ) {
					WP_CLI::error( "category file is missing the '$k' field" );
				}
			}
		}
		return $cats;
	}
}

WP_CLI::add_command( 'dyofix-cat', 'Dyofix_Category_Command' );
