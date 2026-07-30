# Template knowledge workflow

The template-knowledge tools are independent of the fixed `<page N>` deck input contract. They learn reusable layout and design primitives; they do not paginate source documents.

## Tools

1. `inspect_template` accepts one bounded inline `referenceHtml` string. It returns normalized A4 landscape canvas/grid data, generic content roles, component hierarchy, typography, palette, spacing, visual ratios, and sanitization findings. Visible prose, branding, filenames, logos, watermarks, and source assets are never copied into the blueprint.
2. `create_template_from_reference` accepts exactly one inline HTML reference, bounded PNG/JPEG/WebP data URL, or strict `TemplateBlueprint`.
   - HTML is inspected, compiled with server-owned components, validated as an ordinary template/profile pair, rendered in Chromium, and persisted only when all hard gates pass.
   - If no multimodal analyzer is configured, image input returns `needs_analysis`, a stable prompt, and the exact public blueprint JSON Schema. It does not create a knowledge record or compiled files. A caller can submit the validated blueprint in a later call.
   - Compiled templates never use the source screenshot as a background and never embed source pixels, visible source copy, logos, watermarks, or remote resources.
   - The MCP structured result is returned under a strict `result` field whose status is `needs_analysis` or `approved`.
3. `list_template_knowledge` returns immutable logical knowledge IDs, source type/hash, template version, capability tags, closed artifact names, and Chromium QA evidence. It never returns physical paths or raw source data.

## Persistence and promotion

Approved records are stored below the server-owned `<PPT_OUTPUT_ROOT>/template-knowledge` root. Callers cannot choose this location. Each record contains sanitized `blueprint.json`, self-contained `template.html`, strict `profile.json`, `qa.json`, and a Chromium `preview.png` under closed artifact names.

Learned templates are not inserted into the startup-loaded template catalog during the active process. To enable selection, an operator must promote the immutable `template.html` and `profile.json` into a server template family and restart the server. This explicit promotion boundary keeps startup catalog approval deterministic.
