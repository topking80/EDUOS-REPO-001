# Digital learning resources (LRH-01)

The district's catalog of digital learning resources: reference works, PDFs, e-books, offline archives,
audio, video, map packages and course packages. It sits beside the physical library (Library tab) and
follows the Project NOMAD plan (`docs/PROJECT-NOMAD-CAPABILITY-EXTRACTION-INTEGRATION-PLAN.md`, §15).

This step is **metadata only**. EduOS records what a resource is, where it comes from, its licence and
its checksum, and links people to the source. Copying files to school nodes is provisioning (LRH-03).

## Who does what

| Who | Can |
|---|---|
| Superintendent, district IT | Add draft resources and collections, review licences (not their own), retire |
| Superintendent | Publish resources and collections |
| Principal (or acting vice principal), librarian | Choose published collections for their own school, or stop using them |
| Everyone in a school | Browse published resources in the collections their school chose |

Districts only. Homeschool families and private schools don't have this catalog yet.

## The rules the database enforces (migration 171)

- **No licence, no publication.** A published resource must have an approved licence and a SHA-256
  checksum (a CHECK constraint, so not even the API can skip it).
- **Two people.** The person who reviews a licence can't be the person who added the resource.
  Changing the source link, licence, version or checksum of a draft sends the licence back to review.
- **Only drafts change.** A published resource is retired and replaced with a new version.
- **Only the superintendent publishes** (a row-level-security check on the update).
- **A collection publishes only when every resource in it is published.**
- **Visibility.** Everything is scoped to the district (forced RLS). Outside the catalog managers, a
  person sees a resource only when it is published, sits in a published collection, and their school
  chose that collection. The audience narrows it further: *Staff* and *Emergency staff* resources
  aren't shown to students or families. Students see only resources whose grade range includes their
  grade.
- **No student records.** The tables hold no student, guardian or learner columns; a test checks this.
- **Audit.** Every create, change, licence decision, publication, retirement and school choice is in
  `audit_events`.

Licence review notes and status are shown only to catalog managers.

## API

```
GET   /api/resources/catalog                                   managers
POST  /api/resources                                           managers: a draft
PATCH /api/resources/:id                                       managers: drafts only
POST  /api/resources/:id/license-review {decision, note}       managers, not the creator
POST  /api/resources/:id/publish                               superintendent
POST  /api/resources/:id/retire {reason}                       managers
POST  /api/resource-collections {name, description?, reviewBy?}
POST  /api/resource-collections/:id/items {resourceId}         draft collections
DELETE /api/resource-collections/:id/items/:resourceId
POST  /api/resource-collections/:id/publish                    superintendent
POST  /api/resource-collections/:id/retire
GET   /api/resource-collections/available                      school leads
POST  /api/resource-collections/:id/select | /unselect         school leads, own school
GET   /api/resources?q&subject&grade&type                      everyone, filtered as above
GET   /api/resources/:id
```

## Not yet

- Files on school nodes, quotas and resumable transfer (LRH-03, LRH-04).
- A written district content policy and reminders when a collection's review date passes (LRH-02).
- Full-text search and the assistant (LRH-07, LRH-08).

The licence review records what a district reviewer checked. It isn't a legal opinion, and EduOS
makes no claim that a resource complies with any licence or law beyond what the reviewer recorded.
