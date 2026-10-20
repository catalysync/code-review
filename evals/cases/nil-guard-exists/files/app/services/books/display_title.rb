module Books
  class DisplayTitle
    def self.call(book)
      return '' if book.nil? || book.title.blank?

      title = book.title.strip
      return title unless book.edition_label.present?

      "#{title} (#{book.edition_label})"
    end
  end
end
