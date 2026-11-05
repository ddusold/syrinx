<script setup lang="ts">
import { useView, useViewContext } from "@syrinx/ui-vue";
import { computed } from "vue";
import { isList, money, selection, type BrowserData } from "./selection.js";

const view = useView<BrowserData>();
const [selected, select] = useViewContext(selection);
const items = computed(() => (isList(view.value.data) ? view.value.data.items : []));
</script>

<template>
  <nav class="list" aria-label="Invoices">
    <p v-if="items.length === 0" class="empty">No invoices yet.</p>
    <button
      v-for="invoice in items"
      :key="invoice.id"
      type="button"
      class="row"
      :aria-current="invoice.id === selected.id"
      :data-id="invoice.id"
      @click="select({ id: invoice.id })"
    >
      <span class="customer">{{ invoice.customer }}</span>
      <span class="amount">{{ money(invoice.totalCents, view.host.locale) }}</span>
      <span class="status" :data-status="invoice.status">{{ invoice.status }}</span>
    </button>
  </nav>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--sx-radius);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.row:hover {
  background: var(--sx-surface);
}
.row[aria-current="true"] {
  border-color: var(--sx-border);
  background: var(--sx-surface);
}
.customer {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.amount {
  font-variant-numeric: tabular-nums;
}
.status {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--sx-surface);
  color: var(--sx-muted);
  font-size: 12px;
}
.status[data-status="draft"] {
  background: var(--sx-accent-soft);
  color: var(--sx-accent);
}
.empty {
  margin: 0;
  color: var(--sx-muted);
}
</style>
