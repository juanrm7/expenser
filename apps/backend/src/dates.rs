//! Calendar logic, in the server's local time zone (`TZ`). Weeks run Saturday through Friday.

use chrono::{
    DateTime, Datelike, Days, Local, NaiveDate, NaiveTime, TimeDelta, TimeZone, Utc, Weekday,
};

/// Parses a strict `YYYY-MM-DD` calendar date (chrono alone would also accept `2026-2-3`).
pub fn parse_date(value: &str) -> Option<NaiveDate> {
    let well_formed = value.len() == 10
        && value.bytes().enumerate().all(|(i, byte)| match i {
            4 | 7 => byte == b'-',
            _ => byte.is_ascii_digit(),
        });
    if !well_formed {
        return None;
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()
}

/// The local calendar date of an instant.
pub fn local_date(instant: DateTime<Utc>) -> NaiveDate {
    instant.with_timezone(&Local).date_naive()
}

/// The Saturday a date's week starts on.
pub fn week_start(date: NaiveDate) -> NaiveDate {
    date - Days::new(date.weekday().days_since(Weekday::Sat).into())
}

/// The first day of a date's month.
pub fn month_start(date: NaiveDate) -> NaiveDate {
    date - Days::new(date.day0().into())
}

/// The instant a local calendar day begins.
pub fn start_of_day(date: NaiveDate) -> DateTime<Utc> {
    let midnight = date.and_time(NaiveTime::MIN);
    // `earliest()` is only None where a DST jump skips midnight; the day then starts an hour later.
    Local
        .from_local_datetime(&midnight)
        .earliest()
        .or_else(|| {
            Local
                .from_local_datetime(&(midnight + TimeDelta::hours(1)))
                .earliest()
        })
        .expect("every local day has a start")
        .to_utc()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn date(value: &str) -> NaiveDate {
        parse_date(value).unwrap()
    }

    #[test]
    fn week_starts_on_saturday_across_month_year_and_leap_day_boundaries() {
        for (day, expected) in [
            ("2026-10-17", "2026-10-17"),
            ("2026-10-18", "2026-10-17"),
            ("2026-10-23", "2026-10-17"),
            ("2026-01-01", "2025-12-27"),
            ("2024-03-01", "2024-02-24"),
        ] {
            assert_eq!(week_start(date(day)), date(expected), "week of {day}");
        }
    }

    #[test]
    fn parses_only_valid_strict_dates() {
        assert_eq!(parse_date("2026-02-30"), None);
        assert_eq!(parse_date("2026-2-03"), None);
        assert_eq!(parse_date("+2026-0203"), None);
        assert_eq!(parse_date("2024-02-29").unwrap().to_string(), "2024-02-29");
    }

    #[test]
    fn days_start_at_local_midnight() {
        let start = start_of_day(date("2026-10-12"));
        assert_eq!(local_date(start), date("2026-10-12"));
        assert_eq!(
            local_date(start - TimeDelta::milliseconds(1)),
            date("2026-10-11")
        );
        assert_eq!(month_start(date("2026-10-31")), date("2026-10-01"));
    }
}
