-- 35.7.0 library inventory, catalogue ingestion and district resource coordination.
CREATE TABLE IF NOT EXISTS library_catalog_imports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 120),
 source_type text NOT NULL CHECK(source_type IN ('csv','json','marc','destiny','follett','alexandria','other')),
 imported_by uuid NOT NULL REFERENCES users(id),
 row_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 isbn text,
 title text NOT NULL,
 creator text,
 publisher text,
 publication_year integer,
 subject text,
 call_number text,
 barcode text,
 copy_count integer NOT NULL DEFAULT 1 CHECK(copy_count BETWEEN 1 AND 100000),
 available_count integer NOT NULL DEFAULT 1 CHECK(available_count BETWEEN 0 AND copy_count),
 source_import_id uuid REFERENCES library_catalog_imports(id) ON DELETE SET NULL,
 source_record_key text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(district_id,school_id,barcode)
);
CREATE INDEX IF NOT EXISTS library_items_school_title_idx ON library_items(district_id,school_id,title);
CREATE INDEX IF NOT EXISTS library_items_isbn_idx ON library_items(district_id,isbn);
CREATE TABLE IF NOT EXISTS library_resource_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 item_id uuid REFERENCES library_items(id) ON DELETE SET NULL,
 request_type text NOT NULL CHECK(request_type IN ('transfer','purchase','repair','withdrawal','review')),
 title text NOT NULL,
 quantity integer NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 10000),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','in_transit','completed','declined','cancelled')),
 from_school_id uuid REFERENCES schools(id),
 to_school_id uuid REFERENCES schools(id),
 note text,
 requested_by uuid NOT NULL REFERENCES users(id),
 reviewed_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(from_school_id IS NULL OR from_school_id <> to_school_id)
);
CREATE INDEX IF NOT EXISTS library_requests_district_status_idx ON library_resource_requests(district_id,status,created_at DESC);
ALTER TABLE library_catalog_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_catalog_imports FORCE ROW LEVEL SECURITY;
ALTER TABLE library_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_items FORCE ROW LEVEL SECURITY;
ALTER TABLE library_resource_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_resource_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS library_import_scope ON library_catalog_imports;
CREATE POLICY library_import_scope ON library_catalog_imports USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid) WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
DROP POLICY IF EXISTS library_item_scope ON library_items;
CREATE POLICY library_item_scope ON library_items USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid) WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
DROP POLICY IF EXISTS library_request_scope ON library_resource_requests;
CREATE POLICY library_request_scope ON library_resource_requests USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid) WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
