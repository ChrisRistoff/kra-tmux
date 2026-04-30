export type SearchOptions = {
  prompt: string;
  itemsArray: string[];
  /** Optional contextual header rendered above the picker. */
  header?: string;
  /** Optional details callback rendered in the right-hand side panel. */
  details?: (item: string, index: number) => string | Promise<string>;
  /** Whether picker details content uses blessed tags. */
  detailsUseTags?: boolean;
  /** Optional pre-selected item value. */
  selected?: string;
  /** When false, hides the right-hand details panel. Default true. */
  showDetailsPanel?: boolean;
  /** Sliding-window page size; load more items as user scrolls past end. */
  pageSize?: number;
}
