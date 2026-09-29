export const load = (id: number) => fetch(`/api/orders/${id}`);
export const any = (url: string) => fetch(url);
