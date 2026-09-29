class OrdersTests { async Task GetsAnOrder(int id) { await _client.GetAsync($"api/orders/{id}"); } }
