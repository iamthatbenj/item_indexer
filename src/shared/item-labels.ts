export const ITEM_LABEL_LIMIT = 100;
export const itemLabelKinds = ["category", "location"] as const;
export type ItemLabelKind = typeof itemLabelKinds[number];
export type ItemLabel = { id: string; name: string };
export type ItemLabelChoices = Record<ItemLabelKind, ItemLabel[]>;
export type ItemLabelInput = Partial<Record<ItemLabelKind, { id?: string; name?: string }>>;
