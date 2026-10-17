import { screen } from "@testing-library/react";
import { installOrdersStreams, ordersDetailHandlers } from "../fixtures/data/database-detail";
import { ordersDb } from "../fixtures/data/databases";
import { ago } from "../fixtures/time";
import { exportScreen } from "../harness";

const QUERY = `select status, count(*) as orders, sum(total) as revenue
from orders
where placed_at > now() - interval '7 days'
group by status
order by orders desc;`;

it("data-database-console", async () => {
  await exportScreen({
    id: "data-database-console",
    title: "Database · Console",
    group: "Data",
    route: "/databases/orders-db/console",
    handlers: ordersDetailHandlers(),
    before: () => {
      installOrdersStreams();
      // The operator's last query and a short history, as the console keeps them per database.
      localStorage.setItem(`opfield-database-console-input:${ordersDb.id}`, QUERY);
      localStorage.setItem(
        `opfield-database-console-history:${ordersDb.id}`,
        JSON.stringify([
          { query: QUERY, executedAt: ago(4, "m") },
          { query: "select count(*) from order_items;", executedAt: ago(2, "h") },
        ])
      );
    },
    ready: async () => {
      await screen.findByText("SQL Console");
    },
    placeholders: [
      { selector: "div.min-w-0.flex-col[style] .cm-editor", label: "SQL editor (CodeMirror)" },
      {
        selector: "div.min-w-0.flex-1.flex-col .cm-editor",
        label: "Query output (CodeMirror, read-only)",
      },
    ],
  });
});
