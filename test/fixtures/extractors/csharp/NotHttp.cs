namespace Shop.Web.Services;

// GetAsync, DeleteAsync and friends also exist on caches and repositories. Without a
// client-like receiver or a URL containing "/", they are not HTTP. Expect no seams.
public class SessionService(IDistributedCache _cache, IRepository _repository, IStore _store)
{
    public async Task Run(int id)
    {
        await _cache.GetAsync("user-settings");
        await _repository.GetAsync(id);
        await _store.DeleteAsync($"session:{id}");
    }
}
