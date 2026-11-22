# TC-04 — Student history portfolio

Students and families browse a student's history: every item accepted into
it, newest first, grouped by school year (August to July, unless an item names
its own year).

## Who sees what

The database relationship rules (`db/088`, `db/090`) decide which items each
viewer sees; the portfolio only adds that the item must be `published`
(accepted into the history). Drafts, items with the school and items waiting
for the family never appear.

| Viewer | Sees |
|---|---|
| The student ("My history" tab) | family, student and school items; not a parent's private notes |
| A parent or guardian (child card → History & portfolio) | the same, plus their own private notes |
| A teacher of the student | school/classroom items and their own items; never family memories |
| Anyone not related to the student | 404 |

Filters (school year, kind, type), text search and the counts shown are all
computed from the items the viewer can already see, so they can't reveal
anything else. A `%` or `_` in a search is matched literally.

## API

`GET /api/history/portfolio?studentId=&year=&kind=&type=&q=&cursor=`
(`studentId` is optional for a pupil.) Returns `{ student, items, nextCursor,
facets: { years, kinds, types, total } }`, 50 items per page; pass
`nextCursor` back as `cursor` for the next page. `Cache-Control: no-store`.

## Not in this step

Photo, video and document previews (wait for private storage and scanning),
milestone groupings beyond school year, and printable/exportable portfolios.
