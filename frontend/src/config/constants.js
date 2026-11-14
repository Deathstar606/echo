/**
 * Shared frontend configuration constants for MaxiText AI Studio / Echo.
 * Supports user-centric multi-tenant workspace context with fallback.
 */
export const DEFAULT_WORKSPACE_ID = "684a8863-5094-4c8b-9b15-c50c06335b7f";
export const DEFAULT_WORKSPACE_NAME = "Veloura Apparel";

// Backwards-compatible aliases
export const DEFAULT_BUSINESS_ID = DEFAULT_WORKSPACE_ID;
export const DEFAULT_BUSINESS_NAME = DEFAULT_WORKSPACE_NAME;

export const STORAGE_KEYS = {
  USER_ID: "maxitext_user_id",
  USER_PROFILE: "maxitext_user_profile",
  ACTIVE_WORKSPACE_ID: "maxitext_active_workspace_id",
  ACTIVE_WORKSPACE_NAME: "maxitext_active_workspace_name",
  ACTIVE_BUSINESS_ID: "maxitext_active_business_id",
  ACTIVE_BUSINESS_NAME: "maxitext_active_business_name",
  NO_WORKSPACE_SELECTED: "maxitext_no_workspace_selected",
  CUSTOMER_ID: "maxitext_customer_id",
  CUSTOMER_PROFILE: "maxitext_customer_profile",
  CUSTOMER_BUSINESS_ID: "maxitext_customer_business_id",
  CONVERSATION_ID: "maxitext_conversation_id",
};

/**
 * Retrieves the currently logged-in user profile from localStorage.
 */
export function getLoggedInUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.USER_PROFILE);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {
    // Ignore parse error
  }
  return null;
}

/**
 * Persists the logged-in user profile to localStorage.
 */
export function setLoggedInUser(user) {
  try {
    if (user) {
      localStorage.setItem(STORAGE_KEYS.USER_PROFILE, JSON.stringify(user));
      if (user.id) {
        localStorage.setItem(STORAGE_KEYS.USER_ID, String(user.id));
      }
    } else {
      localStorage.removeItem(STORAGE_KEYS.USER_PROFILE);
      localStorage.removeItem(STORAGE_KEYS.USER_ID);
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_WORKSPACE_ID);
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_BUSINESS_ID);
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_WORKSPACE_NAME);
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_BUSINESS_NAME);
      localStorage.setItem(STORAGE_KEYS.NO_WORKSPACE_SELECTED, "1");
      WORKSPACE_ID = "";
      BUSINESS_ID = "";
    }
  } catch {
    // Ignore storage errors
  }
}

/**
 * Retrieves the currently active workspace ID from browser storage.
 * Strictly returns "" when no user is logged in or when no workspace is selected.
 */
export function getActiveWorkspaceId() {
  try {
    if (!getLoggedInUser()?.id) {
      return "";
    }
    if (localStorage.getItem(STORAGE_KEYS.NO_WORKSPACE_SELECTED) === "1") {
      return "";
    }
    const stored =
      localStorage.getItem(STORAGE_KEYS.ACTIVE_WORKSPACE_ID) ||
      localStorage.getItem(STORAGE_KEYS.ACTIVE_BUSINESS_ID);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  } catch {
    // Ignore storage access errors
  }
  return "";
}

export function getActiveBusinessId() {
  return getActiveWorkspaceId();
}

/**
 * Retrieves the currently active workspace name from browser storage.
 */
export function getActiveWorkspaceName() {
  try {
    if (!getLoggedInUser()?.id) {
      return "";
    }
    if (localStorage.getItem(STORAGE_KEYS.NO_WORKSPACE_SELECTED) === "1") {
      return "No Workspace Selected";
    }
    const stored =
      localStorage.getItem(STORAGE_KEYS.ACTIVE_WORKSPACE_NAME) ||
      localStorage.getItem(STORAGE_KEYS.ACTIVE_BUSINESS_NAME);
    if (stored && stored.trim()) {
      return stored.trim();
    }
  } catch {
    // Ignore storage access errors
  }
  return "No Workspace Selected";
}

export function getActiveBusinessName() {
  return getActiveWorkspaceName();
}

/**
 * Persists the active workspace ID and name to localStorage.
 */
export function setActiveWorkspace(id, name) {
  try {
    if (id) {
      const cleanId = String(id).trim();
      localStorage.removeItem(STORAGE_KEYS.NO_WORKSPACE_SELECTED);
      localStorage.setItem(STORAGE_KEYS.ACTIVE_WORKSPACE_ID, cleanId);
      localStorage.setItem(STORAGE_KEYS.ACTIVE_BUSINESS_ID, cleanId);
      BUSINESS_ID = cleanId;
      WORKSPACE_ID = cleanId;
    }
    if (name) {
      const cleanName = String(name).trim();
      localStorage.setItem(STORAGE_KEYS.ACTIVE_WORKSPACE_NAME, cleanName);
      localStorage.setItem(STORAGE_KEYS.ACTIVE_BUSINESS_NAME, cleanName);
    }
  } catch {
    // Ignore storage access errors
  }
}

/**
 * Clears active workspace selection from browser storage.
 * Never falls back to any default/seed workspace ID.
 */
export function clearActiveWorkspace(markNoneSelected = true) {
  try {
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_WORKSPACE_ID);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_BUSINESS_ID);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_WORKSPACE_NAME);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_BUSINESS_NAME);
    if (markNoneSelected) {
      localStorage.setItem(STORAGE_KEYS.NO_WORKSPACE_SELECTED, "1");
    } else {
      localStorage.removeItem(STORAGE_KEYS.NO_WORKSPACE_SELECTED);
    }
    WORKSPACE_ID = "";
    BUSINESS_ID = "";
  } catch {
    // Ignore storage access errors
  }
}

export function setActiveBusiness(id, name) {
  setActiveWorkspace(id, name);
}

/**
 * Dynamic references for backward compatibility.
 */
export let WORKSPACE_ID = getActiveWorkspaceId();
export let BUSINESS_ID = WORKSPACE_ID;

export const API_BASE_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_BASE_URL) ||
  "http://localhost:3000";
//"https://echo-back.vercel.app";

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
  },
};
