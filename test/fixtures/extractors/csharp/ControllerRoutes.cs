using Microsoft.AspNetCore.Mvc;

namespace Orders.Api;

// Class and action templates combine; route constraints and named arguments are ignored.
[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    [HttpGet] // seam: route GET /api/orders
    public IActionResult List() => Ok();

    [HttpGet("{id:int}", Name = "GetOrder")] // seam: route GET /api/orders/{}
    public IActionResult Get(int id) => Ok();

    [HttpDelete("{id}")] // seam: route DELETE /api/orders/{}
    public IActionResult Delete(int id) => Ok();
}
