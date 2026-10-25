export function parseRoute(hash: string): {
  view: "overview" | "settings" | "list";
  listId: string | null;
  itemId: string | null;
} {
  const [route, query = ""] = hash.replace(/^#/, "").split("?");
  if (route === "settings")
    return { view: "settings", listId: null, itemId: null };
  if (route.startsWith("list/")) {
    try {
      const listId = decodeURIComponent(route.slice(5));
      if (!listId) throw new Error("Empty list");
      return {
        view: "list",
        listId,
        itemId: new URLSearchParams(query).get("item"),
      };
    } catch {
      /* Invalid links return to the list overview. */
    }
  }
  return { view: "overview", listId: null, itemId: null };
}
