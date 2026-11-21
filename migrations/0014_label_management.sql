-- A merged label remains available to historical item versions, not to current assignments.
ALTER TABLE item_category_labels ADD COLUMN merged_into_id TEXT REFERENCES item_category_labels(id);
ALTER TABLE item_location_labels ADD COLUMN merged_into_id TEXT REFERENCES item_location_labels(id);
CREATE INDEX items_collection_category ON items(collection_id, category_id);
CREATE INDEX items_collection_location ON items(collection_id, location_id);
