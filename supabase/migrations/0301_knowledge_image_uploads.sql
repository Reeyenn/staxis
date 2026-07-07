-- ═══════════════════════════════════════════════════════════════════════════
-- 0301 — Knowledge hub: accept photo/scan image uploads for AI OCR.
--
-- The Knowledge hub now transcribes scanned PDFs AND uploaded photos with
-- Claude vision on the Fly worker (job kind 'doc_ocr' → chunk → embed → search).
-- For an image PUT to succeed, its Content-Type must be in the private
-- 'knowledge-docs' bucket's allowed_mime_types — so widen that list to add
-- jpeg / png / webp alongside the existing document set. The 10 MB size limit
-- and the private/service-role-only posture are unchanged.
--
-- No other schema change is needed for OCR: workflow_jobs.kind is free-text
-- (0201, no CHECK constraint) so 'doc_ocr' flows through the existing queue,
-- and the extraction lifecycle reuses the existing 'processing' status
-- ("Reading scan…") — no new enum value on knowledge_documents.extraction_status.
--
-- APPLY MANUALLY (migrations are never auto-applied on deploy). After applying,
-- run:  NOTIFY pgrst, 'reload schema';  (or hit /api/admin/doctor with auth).
-- ═══════════════════════════════════════════════════════════════════════════

update storage.buckets
   set allowed_mime_types = array[
         'application/pdf',
         'text/plain',
         'text/markdown',
         'text/csv',
         'application/msword',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'image/jpeg',
         'image/png',
         'image/webp'
       ]
 where id = 'knowledge-docs';

insert into public.applied_migrations (version, description)
values (
  '0301',
  'Knowledge hub: widen knowledge-docs bucket allowed_mime_types to accept image/jpeg, image/png, image/webp so photos/scans can be uploaded and OCR''d by the Fly vision worker (job kind doc_ocr → chunk → embed → search). No status-column or workflow_jobs schema change.'
)
on conflict (version) do nothing;

-- Reload PostgREST's schema cache so the change is visible immediately.
notify pgrst, 'reload schema';
