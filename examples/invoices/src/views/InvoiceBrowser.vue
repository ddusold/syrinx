<script setup lang="ts">
import { useView, ViewContext, ViewPart } from "@syrinx/ui-vue";
import InvoiceDetail from "./InvoiceDetail.vue";
import InvoiceList from "./InvoiceList.vue";
import { selection, type BrowserData } from "./selection.js";
import "./theme.css";

const view = useView<BrowserData>();
</script>

<template>
  <ViewContext :context="selection" :payload="view.data">
    <main class="browser" :class="{ single: view.component }">
      <p v-if="view.error" role="alert" class="notice error">{{ view.error.message }}</p>
      <p v-else-if="view.data === undefined" class="notice">Loading invoices…</p>
      <template v-else>
        <ViewPart name="list"><InvoiceList /></ViewPart>
        <ViewPart name="detail"><InvoiceDetail /></ViewPart>
      </template>
    </main>
  </ViewContext>
</template>

<style scoped>
.browser {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
  gap: 12px;
  padding: 12px;
}
.browser.single {
  grid-template-columns: minmax(0, 1fr);
}
@media (max-width: 560px) {
  .browser {
    grid-template-columns: minmax(0, 1fr);
  }
}
.notice {
  grid-column: 1 / -1;
  margin: 0;
  color: var(--sx-muted);
}
.error {
  color: var(--sx-danger);
}
</style>
