/**
 * What the configurator sends to WooCommerce. WooCommerce stays the authority for products, prices
 * and stock: these items only reference existing products and carry the configuration.
 *
 * - `product-options`: a WooCommerce product configured through its product-options form
 *   (ThemeComplete Extra Product Options on clickbed.pl). `fields` are the exact form field names and
 *   values the shop's own product page posts (e.g. `tmcp_select_0: "140 x 200_2"`), so the shop prices
 *   and validates them exactly as for an order placed on the product page.
 * - `sku`: a simple product or a variation looked up by SKU (the cabinet component catalog,
 *   docs/woocommerce-catalog-generation.md).
 */
export type WooLineItem =
  | {
      readonly kind: "product-options";
      readonly productId: number;
      readonly quantity: number;
      readonly fields: Readonly<Record<string, string>>;
      /** Name of the shop's terms-acceptance checkbox field, which only the customer may tick. */
      readonly termsField?: string;
      readonly termsValue?: string;
    }
  | {
      readonly kind: "sku";
      readonly sku: string;
      readonly quantity: number;
      /** Free-form context shown with the cart line (e.g. which part of the cabinet it is). */
      readonly note?: string;
    };
