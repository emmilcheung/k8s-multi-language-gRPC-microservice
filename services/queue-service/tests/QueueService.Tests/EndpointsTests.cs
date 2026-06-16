using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

public class StartupValidationTests
{
    [Fact]
    public void Startup_throws_when_hmac_secret_missing()
    {
        var factory = new WebApplicationFactory<Program>()
            .WithWebHostBuilder(b => b.UseSetting("Queue:RedisConnection", "localhost:6379"));
        // Queue:HmacSecret deliberately not set

        var ex = Record.Exception(() => factory.Services.GetService<object>());
        Assert.NotNull(ex); // ValidateOnStart surfaces as OptionsValidationException
    }
}
