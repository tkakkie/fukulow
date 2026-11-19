# Invariants: sections

Personal sections in the left column (#204): storage, REST, locks and races (server). Writing rules and the other parts: [index](../invariants.md).

| Rule | Test |
|---|---|
| Section storage rejects cross-Organization Member, Channel and section references and same-Organization placements pointing to another Member's section | `server/src/channels/tests/sections_storage.rs::section_storage_rejects_cross_organization_references`, `server/src/channels/tests/sections_storage.rs::section_placement_rejects_another_owners_section` |
| A Member has at most one stored group per Channel, including explicit Other Channels. DMs cannot have placements. | `server/src/channels/tests/sections_storage.rs::section_placement_allows_only_one_group_per_channel`, `server/src/channels/tests/sections_storage.rs::section_storage_rejects_dm_placements` |
| Section deletion removes its placements. The Channel FK requires explicit placement cleanup before deletion. | `server/src/channels/tests/sections_storage.rs::section_delete_removes_only_its_placements`, `server/src/channels/tests/sections_storage.rs::channel_delete_requires_explicit_section_placement_cleanup` |
| The runtime role cannot read or write section, placement, generation or reserved id rows with unset or foreign Organization context | `server/src/channels/tests/sections_storage.rs::section_storage_requires_organization_context` |
| Rename preserves the original section name. A retired section id cannot be reused by its owner. | `server/src/channels/tests/sections_storage.rs::section_id_reservation_survives_rename_and_delete` |
| Section storage requires names of 1–60 Unicode scalars without NUL and nonnegative generations defaulting to zero | `server/src/channels/tests/sections_storage.rs::section_storage_checks_name_length_and_generation` |
