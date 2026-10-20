<script setup lang="ts">
import { useView } from "@syrinx/ui-vue";
import { computed, ref, watch } from "vue";
import type { Customer } from "../customers.js";
import "./theme.css";

// Embedded, the badge gets just a name and looks the rest up; as its own view it gets the whole customer.
const view = useView<Partial<Customer> & { name: string }>();
const looked = ref<Customer>();
const customer = computed(() => (view.value.data?.tier ? view.value.data : (looked.value ?? view.value.data)));
const initials = computed(() =>
  (customer.value?.name ?? "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join(""),
);

watch(
  () => view.value.data?.name,
  async (name) => {
    looked.value = undefined;
    if (!name || view.value.data?.tier) return;
    try {
      looked.value = await view.value.emit.call<Customer>("get", { name });
    } catch {
      // Not served where this view runs (or not found): the name alone still reads fine.
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="badge" :data-tier="customer?.tier ?? 'unknown'">
    <span class="avatar" aria-hidden="true">{{ initials }}</span>
    <span class="text">
      <span class="name">{{ customer?.name ?? "Unknown customer" }}</span>
      <span v-if="customer?.email" class="email">{{ customer.email }}</span>
    </span>
    <span v-if="customer?.tier" class="tier">{{ customer.tier }}</span>
  </div>
</template>

<style scoped>
.badge {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 8px;
  border-radius: var(--sx-radius);
  background: var(--sx-surface);
}
.avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--sx-accent-soft);
  color: var(--sx-accent);
  font-size: 13px;
  font-weight: 600;
}
.text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.name,
.email {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.email {
  color: var(--sx-muted);
  font-size: 12px;
}
.tier {
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--sx-border);
  font-size: 12px;
  text-transform: capitalize;
}
.badge[data-tier="gold"] .tier {
  border-color: #c99a2e;
  color: #9a6f12;
}
</style>
