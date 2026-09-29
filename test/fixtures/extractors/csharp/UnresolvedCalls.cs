namespace Shop.Web.Services;

// An HttpClient-only method with a URL known only at run time is recorded without a key, so
// answers can say it exists. The cache call with a run-time key is not HTTP and is skipped.
// A known base followed directly by a run-time path is still a run-time URL.
public class Proxy(HttpClient _http, IDistributedCache _cache)
{
    private const string Base = "api/";

    public async Task Run(string url, string key, string path)
    {
        await _http.GetFromJsonAsync<Item>(url); // seam: call GET <run-time>
        await _cache.GetAsync(key);
        await _http.GetFromJsonAsync<Item>($"{Base}{path}"); // seam: call GET <run-time>
    }
}
