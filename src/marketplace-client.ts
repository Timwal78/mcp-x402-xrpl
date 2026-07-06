/**
 * @scriptmasterlabs/mcp-x402
 *
 * marketplace-client.ts — real, persistent listing directory backed by
 * Supabase Postgres. This is a genuine multi-seller marketplace: anyone
 * (ScriptMasterLabs or a third party) can list an x402-payable API here for
 * AI agents to discover, not just this router's own tools.
 *
 * ScriptMasterLabs listings are flagged `is_scriptmasterlabs: true` and sort
 * first in listResourceListing() — that's a default ordering/recommendation
 * only. Nothing in this module blocks an agent from reading, choosing, and
 * paying a third-party listing instead; a rejected/skipped ScriptMasterLabs
 * listing is not an error condition anywhere in this code.
 *
 * Table: public.marketplace_listings (Supabase project "SERP",
 * mkftltqjxeqejztzomzf). RLS: public SELECT on status='active' rows only;
 * INSERT/UPDATE/DELETE require the service_role key used here, which
 * bypasses RLS — so only this server (after verifying a real listing-fee
 * payment) can write new listings.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface MarketplaceListing {
  id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string[];
  baseUrl: string;
  endpoint: string;
  method: string;
  cost: string;
  currency: string | null;
  network: string | null;
  payTo: string | null;
  paymentNote: string | null;
  isScriptMasterLabs: boolean;
  status: string;
  tags: string[];
  createdAt: string;
}

export interface NewListingInput {
  name: string;
  tagline?: string;
  description?: string;
  category?: string[];
  baseUrl: string;
  endpoint: string;
  method?: string;
  cost: string;
  currency?: string;
  network?: string;
  payTo?: string;
  paymentNote?: string;
  tags?: string[];
  submittedByWallet?: string;
  listingFeeAmount?: string;
  listingFeeCurrency?: string;
  listingFeeTxHash?: string;
}

interface ListingRow {
  id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  category: string[];
  base_url: string;
  endpoint: string;
  method: string;
  cost: string;
  currency: string | null;
  network: string | null;
  pay_to: string | null;
  payment_note: string | null;
  is_scriptmasterlabs: boolean;
  status: string;
  tags: string[];
  created_at: string;
}

function rowToListing(row: ListingRow): MarketplaceListing {
  return {
    id: row.id,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    category: row.category ?? [],
    baseUrl: row.base_url,
    endpoint: row.endpoint,
    method: row.method,
    cost: row.cost,
    currency: row.currency,
    network: row.network,
    payTo: row.pay_to,
    paymentNote: row.payment_note,
    isScriptMasterLabs: row.is_scriptmasterlabs,
    status: row.status,
    tags: row.tags ?? [],
    createdAt: row.created_at,
  };
}

export class MarketplaceClient {
  private readonly client: SupabaseClient;

  constructor(supabaseUrl: string, serviceRoleKey: string) {
    this.client = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });
  }

  /**
   * List active marketplace listings. ScriptMasterLabs listings sort first
   * (default recommendation, not a requirement — agents can freely pick any
   * other row), then most recently listed third-party entries.
   */
  async listListings(opts?: { category?: string; limit?: number }): Promise<MarketplaceListing[]> {
    let query = this.client
      .from("marketplace_listings")
      .select("*")
      .eq("status", "active")
      .order("is_scriptmasterlabs", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(opts?.limit ?? 200);

    if (opts?.category) {
      query = query.contains("category", [opts.category]);
    }

    const { data, error } = await query;
    if (error) throw new Error(`[marketplace-client] listListings failed: ${error.message}`);
    return (data as ListingRow[]).map(rowToListing);
  }

  /**
   * Inserts a new third-party listing. Caller is responsible for verifying
   * the listing fee payment BEFORE calling this — this method does not
   * itself check payment, it only persists the row.
   */
  async submitListing(input: NewListingInput): Promise<MarketplaceListing> {
    const { data, error } = await this.client
      .from("marketplace_listings")
      .insert({
        name: input.name,
        tagline: input.tagline ?? null,
        description: input.description ?? null,
        category: input.category ?? [],
        base_url: input.baseUrl,
        endpoint: input.endpoint,
        method: input.method ?? "GET",
        cost: input.cost,
        currency: input.currency ?? null,
        network: input.network ?? null,
        pay_to: input.payTo ?? null,
        payment_note: input.paymentNote ?? null,
        is_scriptmasterlabs: false,
        status: "active",
        tags: input.tags ?? [],
        submitted_by_wallet: input.submittedByWallet ?? null,
        listing_fee_amount: input.listingFeeAmount ?? null,
        listing_fee_currency: input.listingFeeCurrency ?? null,
        listing_fee_tx_hash: input.listingFeeTxHash ?? null,
      })
      .select("*")
      .single();

    if (error) throw new Error(`[marketplace-client] submitListing failed: ${error.message}`);
    return rowToListing(data as ListingRow);
  }
}
