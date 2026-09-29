namespace Shop.Web.Services;

// HttpRequestMessage, RestSharp requests and Refit interface methods are calls too.
public class Requests
{
    public void Build(int id)
    {
        var message = new HttpRequestMessage(HttpMethod.Patch, $"api/orders/{id}"); // seam: call PATCH /api/orders/{}
        var rest = new RestRequest("api/invoices", Method.Post); // seam: call POST /api/invoices
    }
}

public interface IUsersApi
{
    [Get("/users/{id}")] // seam: call GET /users/{}
    Task<User> GetUser(int id);

    [Post("/users")] // seam: call POST /users
    Task Create([Body] User user);
}
