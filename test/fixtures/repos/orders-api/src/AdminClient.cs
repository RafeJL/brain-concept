class AdminClient { async Task<Order> Order(int id) => await _client.GetFromJsonAsync<Order>($"api/orders/{id}"); }
