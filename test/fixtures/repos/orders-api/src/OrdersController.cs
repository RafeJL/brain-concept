[Route("api/orders")]
public class OrdersController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok();

    [HttpDelete("{id}")]
    public IActionResult Delete(int id) => Ok();
}
