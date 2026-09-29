using Microsoft.AspNetCore.Mvc;

namespace Identity.Api;

// No [Route] on the class: [HttpGet] without a template only constrains the verb of a route
// table defined elsewhere (MapControllerRoute), so it is not an extractable route. An action
// with its own template is attribute routed and is extracted.
public class AccountController : Controller
{
    [HttpGet]
    public IActionResult Login() => View();

    [HttpPost("logout")] // seam: route POST /logout
    public IActionResult Logout() => View();
}
