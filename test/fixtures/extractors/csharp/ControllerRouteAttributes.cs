using Microsoft.AspNetCore.Mvc;

namespace Accounts.Api;

// [Route] on an action with no verb attribute accepts any method; a verb attribute with no
// template takes the action's [Route] template.
[Route("users")]
public class UsersController : ControllerBase
{
    [Route("search")] // seam: route * /users/search
    public IActionResult Search() => Ok();

    [HttpGet] // seam: route GET /users/{}/avatar
    [Route("{id}/avatar")]
    public IActionResult Avatar(int id) => Ok();

    // No attributes: routed by convention, so its path is not in this file.
    public IActionResult Conventional() => Ok();
}
