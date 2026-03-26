package com.klu.model;

import jakarta.persistence.*;
import lombok.*;

@Data               
@NoArgsConstructor  
@AllArgsConstructor 
@Entity
@Table(name = "products")
public class Product {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    private String name;
    private double price;
    private int quantity;

    // Image URL or image path
    private String imageUrl;
}
