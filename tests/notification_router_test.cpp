// ============================================================================
//  notification_router_test.cpp - verification of orchestrator::NotificationRouter
//
//  No external framework on purpose (project rule: basic verification tools for C++).
//
//  Build (MSVC 2022 Developer Command Prompt, /utf-8 is required by the library):
//    cl /std:c++20 /EHsc /W4 /utf-8 /I src src\notification_router.cpp ^
//       tests\notification_router_test.cpp /Fe:tests\notification_router_test.exe
//  Run:
//    tests\notification_router_test.exe config\orchestrator.json
//
//  Exit codes: 0 - all checks passed, 1 - at least one failure.
// ============================================================================

#include "notification_router.h"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

using orchestrator::ChannelKind;
using orchestrator::ConfigError;
using orchestrator::NotificationRouter;
using orchestrator::RoutingDecision;

int g_checks = 0;
int g_failures = 0;

/// Registers one assertion result; failures are reported but do not abort the run.
void check(bool condition, std::string_view expression, int line) {
    ++g_checks;
    if (condition) return;
    ++g_failures;
    std::cerr << "FAIL line " << line << ": " << expression << '\n';
}

#define CHECK(expression) check((expression), #expression, __LINE__)

/// UTC timestamp: utc(2026, 10, 26, 7, 0) -> 2026-10-26T07:00Z (10:00 in Moscow).
NotificationRouter::TimePoint utc(int year, unsigned month, unsigned day, int hour, int minute) {
    using namespace std::chrono;
    const year_month_day date{std::chrono::year{year}, std::chrono::month{month}, std::chrono::day{day}};
    return sys_days{date} + hours{hour} + minutes{minute};
}

/// Mirrors the shape of config/orchestrator.json: telegram 24/7, vk_max 09:00-18:00 MSK.
constexpr std::string_view kSampleConfig = R"json({
  "version": "0.2.0",
  "notification_channels": {
    "telegram": {
      "enabled": true,
      "webhook_url": "https://telegram.example.test/webhook",
      "sender_script": "agents/telegram_sender.py",
      "timeout_sec": 15,
      "work_hours_only": { "enabled": false, "start": "09:00", "end": "18:00", "timezone": "Europe/Moscow" }
    },
    "vk_max": {
      "enabled": true,
      "webhook_url": "ENV_TEST_VK_MAX_URL",
      "sender_script": "agents/vk_max_sender.py",
      "timeout_sec": 15,
      "work_hours_only": { "enabled": true, "start": "09:00", "end": "18:00", "timezone": "Europe/Moscow" }
    }
  }
})json";

void test_config_parsing() {
    const NotificationRouter router = NotificationRouter::from_json(kSampleConfig);
    CHECK(router.size() == 2U);
    CHECK(router.has_channel(ChannelKind::telegram));
    CHECK(router.has_channel(ChannelKind::vk_max));

    const auto& telegram = router.channel(ChannelKind::telegram);
    CHECK(telegram.enabled);
    CHECK(!telegram.work_hours.enabled);
    CHECK(telegram.sender_script == "agents/telegram_sender.py");
    CHECK(telegram.timeout == std::chrono::seconds{15});

    const auto& vk_max = router.channel(ChannelKind::vk_max);
    CHECK(vk_max.enabled);
    CHECK(vk_max.work_hours.enabled);
    CHECK(vk_max.work_hours.start == std::chrono::minutes{540});
    CHECK(vk_max.work_hours.end == std::chrono::minutes{1080});
    CHECK(vk_max.work_hours.timezone == "Europe/Moscow");
    CHECK(vk_max.work_hours.contains(std::chrono::hours{9}));
    CHECK(!vk_max.work_hours.contains(std::chrono::hours{18}));

    CHECK(orchestrator::to_string(ChannelKind::vk_max) == "vk_max");
    CHECK(orchestrator::to_string(ChannelKind::telegram) == "telegram");
    CHECK(orchestrator::channel_from_string("telegram").value() == ChannelKind::telegram);
    CHECK(!orchestrator::channel_from_string("email").has_value());
}

void test_moscow_time_of_day() {
    using namespace std::chrono;
    // Moscow is UTC+3 all year round, so 06:30Z -> 09:30 MSK.
    CHECK(NotificationRouter::moscow_time_of_day(utc(2026, 10, 26, 6, 30)) == minutes{570});
    CHECK(NotificationRouter::moscow_time_of_day(utc(2026, 10, 26, 21, 0)) == minutes{0});
    CHECK(NotificationRouter::moscow_time_of_day(utc(2026, 10, 26, 20, 59)) == minutes{1439});
    CHECK(NotificationRouter::moscow_time_of_day(utc(2026, 1, 1, 0, 0)) == minutes{180});
}

void test_work_hours_gate() {
    using namespace std::chrono;
    const NotificationRouter router = NotificationRouter::from_json(kSampleConfig);

    // Telegram has no work-hours restriction -> alerts are delivered 24/7.
    CHECK(router.is_within_work_hours(ChannelKind::telegram, utc(2026, 10, 26, 3, 0)));
    CHECK(router.is_within_work_hours(ChannelKind::vk_max, utc(2026, 10, 26, 6, 0)));   // 09:00 MSK
    CHECK(!router.is_within_work_hours(ChannelKind::vk_max, utc(2026, 10, 26, 5, 59)));  // 08:59 MSK
    CHECK(router.is_within_work_hours(ChannelKind::vk_max, utc(2026, 10, 26, 14, 59)));  // 17:59 MSK
    CHECK(!router.is_within_work_hours(ChannelKind::vk_max, utc(2026, 10, 26, 15, 0)));  // 18:00 MSK
    CHECK(!router.is_within_work_hours(ChannelKind::vk_max, utc(2026, 10, 26, 3, 0)));   // 06:00 MSK

    const RoutingDecision inside = router.evaluate(ChannelKind::vk_max, utc(2026, 10, 26, 7, 0));
    CHECK(inside.allowed);
    CHECK(inside.reason == "ok");
    CHECK(inside.moscow_time_of_day == minutes{600});

    const RoutingDecision outside = router.evaluate(ChannelKind::vk_max, utc(2026, 10, 26, 18, 0));
    CHECK(!outside.allowed);
    CHECK(outside.reason == "outside_work_hours");
    CHECK(!outside.transport_called);

    CHECK(router.evaluate(ChannelKind::telegram, utc(2026, 10, 26, 18, 0)).allowed);
}

void test_dispatch() {
    using namespace std::chrono;
    const NotificationRouter router = NotificationRouter::from_json(kSampleConfig);

    int calls = 0;
    std::string received;
    const auto transport = [&calls, &received](const orchestrator::NotificationChannel& channel, std::string_view text) {
        ++calls;
        received = std::string{text};
        return channel.enabled ? 0 : 1;  // как реальный sender: 0 - успешная доставка
    };

    const RoutingDecision sent = router.dispatch(ChannelKind::vk_max, "deploy done", transport, utc(2026, 10, 26, 9, 0));
    CHECK(calls == 1);
    CHECK(sent.transport_called);
    CHECK(sent.delivered());
    CHECK(sent.transport_exit_code == 0);
    CHECK(sent.reason == "ok");
    CHECK(received == "deploy done");

    // Outside 09:00-18:00 MSK the VK Max transport must not be called at all.
    const RoutingDecision deferred =
        router.dispatch(ChannelKind::vk_max, "night alert", transport, utc(2026, 10, 26, 20, 0));
    CHECK(calls == 1);
    CHECK(!deferred.transport_called);
    CHECK(!deferred.delivered());
    CHECK(deferred.reason == "outside_work_hours");

    // Telegram alerts are delivered 24/7.
    const RoutingDecision alert =
        router.dispatch(ChannelKind::telegram, "critical incident", transport, utc(2026, 10, 26, 20, 0));
    CHECK(calls == 2);
    CHECK(alert.delivered());

    const auto failing = [](const orchestrator::NotificationChannel&, std::string_view) { return 3; };
    const RoutingDecision failed = router.dispatch(ChannelKind::telegram, "x", failing, utc(2026, 10, 26, 0, 0));
    CHECK(failed.transport_called);
    CHECK(failed.transport_exit_code == 3);
    CHECK(!failed.delivered());
    CHECK(failed.reason == "transport_failed");

    const auto throwing = [](const orchestrator::NotificationChannel&, std::string_view) -> int {
        throw std::runtime_error{"boom"};
    };
    const RoutingDecision broken = router.dispatch(ChannelKind::telegram, "x", throwing, utc(2026, 10, 26, 0, 0));
    CHECK(broken.transport_called);
    CHECK(broken.transport_exit_code == -1);
    CHECK(broken.reason == "transport_exception");

    // Empty transport means "policy check only".
    const RoutingDecision probe = router.dispatch(ChannelKind::telegram, "x", {}, utc(2026, 10, 26, 0, 0));
    CHECK(probe.allowed);
    CHECK(!probe.transport_called);
}

void test_work_hours_window() {
    using namespace std::chrono;
    orchestrator::WorkHoursWindow night_shift;
    night_shift.enabled = true;
    night_shift.start = hours{22};
    night_shift.end = hours{6};
    CHECK(night_shift.contains(hours{23}));
    CHECK(night_shift.contains(hours{0}));
    CHECK(night_shift.contains(hours{5}));
    CHECK(!night_shift.contains(hours{6}));
    CHECK(!night_shift.contains(hours{12}));

    night_shift.start = minutes{0};
    night_shift.end = minutes{0};
    CHECK(night_shift.contains(hours{12}));  // окно нулевой длины = круглые сутки

    const orchestrator::WorkHoursWindow unlimited;
    CHECK(unlimited.contains(hours{3}));
}

void test_config_errors() {
    const auto expect_config_error = [](std::string_view json, const char* label) {
        try {
            static_cast<void>(NotificationRouter::from_json(json));
        } catch (const ConfigError&) {
            return true;
        }
        std::cerr << "expected ConfigError for case: " << label << '\n';
        return false;
    };

    CHECK(expect_config_error("{", "truncated json"));
    CHECK(expect_config_error("[]", "root is an array"));
    CHECK(expect_config_error(R"({"workers": []})", "notification_channels is missing"));
    CHECK(expect_config_error(R"({"notification_channels": {}})", "no channels inside"));
    CHECK(expect_config_error(R"({"notification_channels": {"email": {"enabled": true}}})", "unknown channel"));
    CHECK(expect_config_error(R"({"notification_channels": {"vk_max": {"enabled": "yes"}}})", "enabled is a string"));
    CHECK(expect_config_error(
        R"({"notification_channels": {"vk_max": {"enabled": true, "work_hours_only": {"start": "9-00"}}}})",
        "invalid HH:MM"));
    CHECK(expect_config_error(
        R"({"notification_channels": {"vk_max": {"enabled": true, "work_hours_only": {"start": "25:00"}}}})",
        "time out of range"));
    CHECK(expect_config_error(
        R"({"notification_channels": {"vk_max": {"enabled": true, "work_hours_only": {"timezone": "Asia/Tokyo"}}}})",
        "unsupported timezone"));
    CHECK(expect_config_error(R"({"notification_channels": {"vk_max": {"enabled": true, "timeout_sec": -5}}})",
                              "negative timeout_sec"));
    CHECK(expect_config_error(R"({"notification_channels": {"vk_max": {"enabled": true, "timeout_sec": "15"}}})",
                              "timeout_sec is a string"));

    try {
        static_cast<void>(NotificationRouter{}.channel(ChannelKind::vk_max));
        std::cerr << "expected ConfigError for a missing channel lookup\n";
        CHECK(false);
    } catch (const ConfigError&) {
        CHECK(true);
    }
}

void test_env_and_encoding() {
    using namespace std::chrono;

#if defined(_MSC_VER)
    _putenv_s("ENV_TEST_VK_MAX_URL", "https://vk.example.test/hook");
#else
    setenv("ENV_TEST_VK_MAX_URL", "https://vk.example.test/hook", 1);
#endif

    const NotificationRouter router = NotificationRouter::from_json(kSampleConfig);
    const auto& vk_max = router.channel(ChannelKind::vk_max);
    CHECK(vk_max.webhook_url == "ENV_TEST_VK_MAX_URL");
    CHECK(vk_max.resolved_webhook_url() == "https://vk.example.test/hook");
    CHECK(vk_max.webhook_configured());

    const auto& telegram = router.channel(ChannelKind::telegram);
    CHECK(telegram.resolved_webhook_url() == "https://telegram.example.test/webhook");

    // BOM перед '{' не должен ломать парсер (файлы Windows часто сохраняются с BOM).
    const NotificationRouter with_bom = NotificationRouter::from_json(
        "\xEF\xBB\xBF{\"notification_channels\": {\"telegram\": {\"enabled\": true}}}");
    CHECK(with_bom.has_channel(ChannelKind::telegram));

    // \uXXXX и суррогатная пара декодируются в UTF-8.
    const NotificationRouter escapes = NotificationRouter::from_json(
        R"({"notification_channels": {"telegram": {"webhook_url": "\u0068ttps://t.test/\uD83D\uDE00",)"
        R"( "sender_script": "agents/\u0074elegram_sender.py"}}})");
    CHECK(escapes.channel(ChannelKind::telegram).webhook_url == "https://t.test/\xF0\x9F\x98\x80");
    CHECK(escapes.channel(ChannelKind::telegram).sender_script == "agents/telegram_sender.py");

    // Краткая форма work_hours_only (bool) и значения по умолчанию.
    const NotificationRouter shorthand = NotificationRouter::from_json(
        R"({"notification_channels": {"vk_max": {"enabled": true, "work_hours_only": true}}})");
    const auto& vk_shorthand = shorthand.channel(ChannelKind::vk_max);
    CHECK(vk_shorthand.work_hours.enabled);
    CHECK(vk_shorthand.work_hours.start == minutes{540});
    CHECK(vk_shorthand.work_hours.end == minutes{1080});
    CHECK(vk_shorthand.timeout == seconds{15});
}

void test_real_config(const std::filesystem::path& config_path) {
    const NotificationRouter router = NotificationRouter::from_file(config_path);
    std::cout << "config: " << config_path.string() << " (channels=" << router.size() << ")\n";
    CHECK(router.has_channel(ChannelKind::telegram));
    CHECK(router.has_channel(ChannelKind::vk_max));

    const auto& telegram = router.channel(ChannelKind::telegram);
    CHECK(telegram.enabled);
    CHECK(!telegram.work_hours.enabled);  // алерты 24/7
    CHECK(!telegram.sender_script.empty());

    const auto& vk_max = router.channel(ChannelKind::vk_max);
    CHECK(vk_max.enabled);
    CHECK(vk_max.work_hours.enabled);  // только 09:00-18:00 МСК
    CHECK(vk_max.work_hours.start == std::chrono::minutes{540});
    CHECK(vk_max.work_hours.end == std::chrono::minutes{1080});
    CHECK(vk_max.work_hours.timezone == "Europe/Moscow");

    // 07:00Z = 10:00 MSK -> доставка разрешена, 17:00Z = 20:00 MSK -> запрещена.
    CHECK(router.evaluate(ChannelKind::vk_max, utc(2026, 10, 26, 7, 0)).allowed);
    CHECK(!router.evaluate(ChannelKind::vk_max, utc(2026, 10, 26, 17, 0)).allowed);
    CHECK(router.evaluate(ChannelKind::telegram, utc(2026, 10, 26, 17, 0)).allowed);

    const std::vector<std::string> argv = router.build_sender_argv(ChannelKind::vk_max, "hello");
    CHECK(argv.size() == 2U);
    if (argv.size() == 2U) {
        CHECK(argv[0] == vk_max.sender_script);
        CHECK(argv[1] == "hello");
    }

    const std::string summary = orchestrator::describe(router.evaluate(ChannelKind::vk_max, utc(2026, 10, 26, 7, 0)));
    std::cout << "describe: " << summary << '\n';
    CHECK(summary.find("channel=vk_max") != std::string::npos);
    CHECK(summary.find("allowed") != std::string::npos);
}

}  // namespace

int main(int argc, char** argv) {
    const std::filesystem::path config_path =
        argc > 1 ? std::filesystem::path{argv[1]} : std::filesystem::path{"config/orchestrator.json"};

    try {
        test_config_parsing();
        test_moscow_time_of_day();
        test_work_hours_gate();
        test_dispatch();
        test_work_hours_window();
        test_config_errors();
        test_env_and_encoding();
        test_real_config(config_path);
    } catch (const std::exception& exc) {
        std::cerr << "UNEXPECTED EXCEPTION: " << exc.what() << '\n';
        return 1;
    }

    std::cout << "checks=" << g_checks << " failures=" << g_failures << '\n';
    if (g_failures != 0) {
        std::cout << "RESULT: FAILED\n";
        return 1;
    }
    std::cout << "RESULT: PASSED\n";
    return 0;
}

