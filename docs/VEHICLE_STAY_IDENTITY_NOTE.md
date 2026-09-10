# Vehicle stay identity — implementation note

This note belongs to the vehicle-stay foundation work. The operational model remains backward-compatible: `vehicles` continues to be the current operational record while `vehicle_stays.id` becomes the immutable visit identity for retention/history work. A readable code is generated as `PLATE-YYYYMMDD-NNN`; it is not the primary key.
