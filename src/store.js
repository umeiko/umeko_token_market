import { reactive } from 'vue';

export const toasts = reactive([]);
export function notify(message, bad = false) {
  const id = Date.now() + Math.random();
  toasts.push({ id, message, bad });
  setTimeout(() => {
    const index = toasts.findIndex((toast) => toast.id === id);
    if (index >= 0) toasts.splice(index, 1);
  }, 3200);
}
export async function run(action) {
  try { return await action(); }
  catch (error) { notify(error.message, true); return null; }
}
