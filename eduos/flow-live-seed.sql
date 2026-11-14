-- Synthetic seed for flow-live-check.mjs. No real people or student data.
DO $$
DECLARE da uuid; db uuid; sa uuid; sb uuid; u uuid; r record;
BEGIN
  INSERT INTO districts(name) VALUES('Alpha Unified (synthetic)') RETURNING id INTO da;
  INSERT INTO districts(name) VALUES('Beta Unified (synthetic)') RETURNING id INTO db;
  INSERT INTO schools(district_id,name) VALUES(da,'Alpha High') RETURNING id INTO sa;
  INSERT INTO schools(district_id,name) VALUES(db,'Beta High') RETURNING id INTO sb;
  FOR r IN SELECT * FROM (VALUES
      ('supA','superintendent',da,NULL::uuid),('prinA','principal',da,sa),('teachA','teacher',da,sa),
      ('parA','parent',da,sa),('pupA','pupil',da,sa),('supB','superintendent',db,NULL::uuid)
    ) AS t(key,role,district,school)
  LOOP
    INSERT INTO users(oidc_issuer,oidc_subject,display_name,email)
      VALUES('synthetic',r.key,'Synthetic '||r.key,r.key||'@example.invalid') RETURNING id INTO u;
    INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES(u,r.district,r.school,r.role,true);
    INSERT INTO sessions(token_hash,csrf_token_hash,user_id,district_id,school_id,role,expires_at)
      VALUES(encode(sha256(('tok-'||r.key||'-0123456789abcdef')::bytea),'hex'),encode(sha256('unused'::bytea),'hex'),
             u,r.district,r.school,r.role,now()+interval '2 hours');
  END LOOP;
  INSERT INTO students(district_id,school_id,local_student_number,display_name,grade_level)
    VALUES(da,sa,'SYN-001','Synthetic Learner','Grade 9');
END $$;
