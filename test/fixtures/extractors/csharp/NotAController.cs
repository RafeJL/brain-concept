namespace Shared;

// Not a controller (no Controller suffix, base class or routing attribute), so its
// attributes are not routes. Expect no seams.
public class Helper
{
    [HttpGet("x")]
    public void X() { }
}
