/**
 * Shared frontend configuration constants for MaxiText AI Workspace.
 * Every business-scoped request MUST use the hardcoded BUSINESS_ID below.
 */
export const BUSINESS_ID = "684a8863-5094-4c8b-9b15-c50c06335b7f";

/* export const API_BASE_URL = "https://echo-smmm.vercel.app"; */
export const API_BASE_URL = "http://localhost:3000";

export const STORAGE_KEYS = {
  CUSTOMER_ID: "maxitext_customer_id",
  CUSTOMER_PROFILE: "maxitext_customer_profile",
  CONVERSATION_ID: "maxitext_conversation_id",
};

/**
 * Product catalog schema metadata for the Sheet Management panel (backed by products.csv).
 */
export const DEMO_SHEETS = {
  products: {
    id: "products",
    name: "products.csv (Veloura Product Catalog)",
    badge: "PRODUCTS SHEET",
    columns: [
      "name",
      "category",
      "description",
      "best",
      "color",
      "discount",
      "ordered",
      "images",
      "size",
      "price",
    ],
    samplePrompts: [
      "Show all best-selling products.",
      "Find products available in Black under 1500.",
      "Show products with ordered count greater than 0.",
      "Increase the discount of all summer shirts by 5%.",
      "Reduce the price of products with a discount of 25% or more by 200.",
    ],
    rows: [],
  },
};
