// Pagination for list endpoints (32.2.0).
//
// Before 32.2.0 every list was silently truncated at a fixed LIMIT (200 students,
// 250 cases, 2,000 users...), so large districts could not see all their data.
// Now there is no cap on the total: every list returns pages of `limit` rows,
// starting at `offset`, and `page.nextOffset` points to the next page (null on
// the last one). PAGE_SIZE_MAX bounds one response (memory/DoS), not the data.
import { config } from "./config.js";

export function pageOf(req, { defaultLimit = config.pageSizeDefault } = {}) {
  const int = v => (/^\d{1,9}$/.test(String(v ?? "")) ? Number(v) : null);
  const limit = Math.min(Math.max(int(req.query?.limit) ?? defaultLimit, 1), config.pageSizeMax);
  const offset = int(req.query?.offset) ?? 0;
  return { limit, offset };
}

// SQL fragment: fetch one extra row to know whether another page exists. Both
// values are integers produced by pageOf(), never request text.
export const pageSql = p => `LIMIT ${Number(p.limit) + 1} OFFSET ${Number(p.offset)}`;

export function paged(rows, p, extra = {}) {
  const hasMore = rows.length > p.limit;
  return { data: hasMore ? rows.slice(0, p.limit) : rows, page: { limit: p.limit, offset: p.offset, nextOffset: hasMore ? p.offset + p.limit : null, ...extra } };
}
