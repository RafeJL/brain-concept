using Microsoft.AspNetCore.Mvc;

namespace Billing.Api;

// [controller] and [action] tokens are replaced; "Async" is trimmed from action names, as
// ASP.NET Core does. An action template starting with ~/ ignores the controller's prefix.
[Route("api/[controller]")]
public class InvoicesController : Controller
{
    [HttpPost("[action]")] // seam: route POST /api/invoices/resend
    public Task<IActionResult> ResendAsync() => Task.FromResult<IActionResult>(Ok());

    [HttpGet("~/health")] // seam: route GET /health
    public IActionResult Health() => Ok();
}
