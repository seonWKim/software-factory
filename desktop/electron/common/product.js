// The product's name, from desktop/package.json productName: the app bundle (scripts/build-desktop-macos.mjs), the
// window, the menu bar item and the dialogs all read it here.
import pkg from "../../package.json" with { type: "json" };

/** "Gongbang". */
export const PRODUCT_NAME = pkg.productName;
