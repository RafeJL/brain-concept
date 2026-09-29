namespace Shop.Web.Services;

// An HttpClient-only method with a URL known only at run time is recorded without a key, so
// answers can say it exists. The cache call with a run-time key is not HTTP and is skipped.
public class Proxy(HttpClient _http, IDistributedCache _cache)
{
    public async Task Run(string url, string key)
    {
        await _http.GetFromJsonAsync<Item>(url); // seam: call GET <run-time>
        await _cache.GetAsync(key);
    }
}
