<script setup lang="ts">
import { Embed, useView, useViewContext } from "@syrinx/ui-vue";
import { computed, ref } from "vue";
import { isList, money, selection, type BrowserData } from "./selection.js";

const view = useView<BrowserData>();
const [selected] = useViewContext(selection);
const invoice = computed(() => {
  const data = view.value.data;
  return isList(data) ? data.items.find((i) => i.id === selected.value.id) : data;
});

const sending = ref(false);
const failure = ref<string>();

async function send() {
  const current = invoice.value;
  if (!current) return;
  sending.value = true;
  failure.value = undefined;
  try {
    await view.value.emit.call("send", { id: current.id });
    // Refresh through a bound operation, so the whole view (and the selection's merge rule) sees the change.
    if (isList(view.value.data)) await view.value.emit.call("list", {});
    else await view.value.emit.call("get", { id: current.id });
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <section class="detail" aria-live="polite">
    <p v-if="!invoice" class="muted">Pick an invoice.</p>
    <template v-else>
      <header>
        <h2>{{ invoice.id }}</h2>
        <span class="status" :data-status="invoice.status">{{ invoice.status }}</span>
      </header>
      <p class="total">{{ money(invoice.totalCents, view.host.locale) }}</p>
      <Embed view="customers/badge" :data="{ name: invoice.customer }" />
      <p v-if="failure" role="alert" class="error">{{ failure }}</p>
      <button
        v-if="view.features.actions && invoice.status === 'draft'"
        type="button"
        class="primary"
        :disabled="sending"
        @click="send"
      >
        {{ sending ? "Sending…" : "Send invoice" }}
      </button>
    </template>
  </section>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--sx-border);
  border-radius: var(--sx-radius);
}
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
h2 {
  margin: 0;
  font-size: 16px;
}
.total {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
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
.primary {
  align-self: flex-start;
  min-height: 36px;
  padding: 0 14px;
  border: 0;
  border-radius: var(--sx-radius);
  background: var(--sx-accent);
  color: var(--sx-on-accent);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.6;
  cursor: progress;
}
.muted {
  margin: 0;
  color: var(--sx-muted);
}
.error {
  margin: 0;
  color: var(--sx-danger);
}
</style>
