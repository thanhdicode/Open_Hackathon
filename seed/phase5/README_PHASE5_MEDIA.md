# YapYep Phase 5 seed + media pack

This pack contains:
- `yapyep_phase5_seed_pack.json`: POIs, demo profiles, demo posts, safety defaults.
- `yapyep_phase5_media_manifest.json`: open-license/public-domain media with source, license, attribution and mapping to seed rows.
- `download_phase5_media.mjs`: downloads the images into `public/demo-media/`.

Run:

```bash
node download_phase5_media.mjs yapyep_phase5_media_manifest.json public/demo-media
```

Important:
- Community profiles/posts are synthetic demo fixtures and must remain labelled as demo.
- Do not present people in source photos as YapYep users.
- Keep attribution/license metadata.
- Official Greenbook facts remain separate from community/demo content.
