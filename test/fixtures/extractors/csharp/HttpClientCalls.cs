namespace Shop.Web.Services;

// HttpClient URLs are usually relative to BaseAddress. Interpolation, concatenation, verbatim
// strings and same-file constants all resolve.
public class OrdersClient(
    HttpClient _http,
    HttpClient _httpClient,
    HttpClient _client,
    HttpClient httpClient,
    IHttpClientFactory _factory)
{
    private const string Base = "api/orders";

    public async Task Run(int id, int customerId, Order order, HttpContent body)
    {
        await _http.GetFromJsonAsync<Order>($"{Base}/{id}"); // seam: call GET /api/orders/{}
        await _httpClient.PostAsJsonAsync("api/orders", order); // seam: call POST /api/orders
        await _client.GetAsync("api/customers/" + customerId); // seam: call GET /api/customers/{}
        await httpClient.DeleteAsync(@"api/orders/" + id); // seam: call DELETE /api/orders/{}
        await _factory.CreateClient("orders").PutAsync($"api/orders/{id}/status", body); // seam: call PUT /api/orders/{}/status
    }
}
