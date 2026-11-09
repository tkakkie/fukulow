use super::*;

fn overflow_posts(scenario: &Scenario) -> Result<(), (usize, usize)> {
    let sends = scenario
        .steps
        .iter()
        .filter_map(|step| match step {
            Step::Post(post) => Some(post.count),
            _ => None,
        })
        .collect::<Vec<_>>();
    let expected = LIVE_QUEUE_CAPACITY + 1;
    match sends.as_slice() {
        [actual] if *actual == expected => Ok(()),
        _ => Err((sends.iter().sum(), expected)),
    }
}

fn overflow_scenario() -> Scenario {
    scenarios()
        .into_iter()
        .find(|scenario| {
            scenario.id == "queue-overflow-closes-with-4008-and-replay-recovers-every-message"
        })
        .unwrap()
}

// This dedicated fixture assertion deliberately stays outside the generic runner.
#[test]
fn overflow_fixture_exceeds_connection_queue_capacity_by_one() {
    assert_eq!(
        overflow_posts(&overflow_scenario()),
        Ok(()),
        "overflow fixture sends must equal LIVE_QUEUE_CAPACITY + 1"
    );
}

#[test]
fn overflow_fixture_rejects_wrong_send_counts() {
    for count in [LIVE_QUEUE_CAPACITY, LIVE_QUEUE_CAPACITY + 2] {
        let mut scenario = overflow_scenario();
        let post = scenario
            .steps
            .iter_mut()
            .find_map(|step| match step {
                Step::Post(post) => Some(post),
                _ => None,
            })
            .unwrap();
        post.count = count;
        assert_eq!(
            overflow_posts(&scenario),
            Err((count, LIVE_QUEUE_CAPACITY + 1))
        );
    }
}
