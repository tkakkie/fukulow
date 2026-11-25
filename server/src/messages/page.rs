use super::ListMessagesQuery;

pub(super) fn valid_page_limit(limit: u16) -> bool {
    (1..=200).contains(&limit)
}

pub(super) struct DirectionalPage {
    pub(super) ascending: bool,
    pub(super) cursor: i64,
    limit: u16,
}

impl DirectionalPage {
    pub(super) fn new(query: &ListMessagesQuery, limit: u16) -> Self {
        let (ascending, cursor) = if let Some(after_seq) = query.after_seq {
            (true, after_seq)
        } else {
            // Convert the exclusive before cursor to an inclusive bound; validation guarantees >= 1.
            (false, query.before_seq.map_or(i64::MAX, |seq| seq - 1))
        };
        Self {
            ascending,
            cursor,
            limit,
        }
    }

    pub(super) fn fetch_limit(&self) -> i64 {
        i64::from(self.limit) + 1
    }

    pub(super) fn finish<T>(&self, mut messages: Vec<T>) -> (Vec<T>, bool) {
        let limit = usize::from(self.limit);
        let has_more = messages.len() > limit;
        messages.truncate(limit);
        if !self.ascending {
            messages.reverse();
        }
        (messages, has_more)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messages::ValidateListMessages;

    #[test]
    fn directional_page_bounds_and_finishes_fetched_messages() {
        let mut query = ListMessagesQuery {
            history_generation: None,
            as_of_seq: None,
            before_seq: None,
            after_seq: None,
            limit: Some(2),
        };
        let latest = DirectionalPage::new(&query, query.validate().unwrap());
        assert!(!latest.ascending);
        assert_eq!(latest.cursor, i64::MAX);
        assert_eq!(latest.fetch_limit(), 3);
        assert_eq!(latest.finish(vec![5, 4, 3]), (vec![4, 5], true));
        assert_eq!(latest.finish(vec![5, 4]), (vec![4, 5], false));

        query.before_seq = Some(1);
        let older = DirectionalPage::new(&query, query.validate().unwrap());
        assert!(!older.ascending);
        assert_eq!(older.cursor, 0);

        query.before_seq = None;
        query.after_seq = Some(2);
        let newer = DirectionalPage::new(&query, query.validate().unwrap());
        assert!(newer.ascending);
        assert_eq!(newer.cursor, 2);
        assert_eq!(newer.finish(vec![3, 4, 5]), (vec![3, 4], true));
        assert_eq!(newer.finish(vec![3, 4]), (vec![3, 4], false));
    }
}
